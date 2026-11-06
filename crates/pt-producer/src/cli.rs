use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Mutex;

/// Controls whether the producer auto-derives GTFS type-4 in-seat transfer rules
/// from `block_id` continuations.
///
/// `auto` (default): derive type-4 rules when the feed declares no type-4
/// entries of its own in `transfers.txt`.
/// `off`: never derive; rely solely on the feed's `transfers.txt`.
///
/// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#transferstxt>
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DeriveInseat {
    /// Derive type-4 in-seat rules from block_id when the feed declares no type-4 of its own.
    #[default]
    Auto,
    /// Never derive (rely solely on the feed's transfers.txt).
    Off,
}

/// Top-level CLI. The producer has two modes:
///
/// - **Default (no subcommand)**: P3 sidecar path — `--gtfs-url`/`--gtfs-path` in, `--out <PATH>`
/// writes a single PTB + JSON sidecars. Acquires `producer.lock`, fault-injection honors
/// `PT_PRODUCER_FAULT_INJECT` env, signals pt-serve via the pidfile.
///
/// Old args remain at the top level for backward compatibility with the
/// existing sidecar invocation. A `periodic-refresh` invocation simply
/// ignores them (the subcommand carries its own args).
#[derive(Parser, Debug, Clone)]
#[command(
    name = "pt-producer",
    version,
    about = "PTN GTFS-to-PTB producer and publisher"
)]
pub struct Args {
    /// Optional subcommand. Without it, the legacy P3 sidecar flow runs.
    #[command(subcommand)]
    pub command: Option<Command>,

    /// GTFS source URL (comma-separated supported for Krakow's 3-feed setup).
    /// Falls back to $GTFS_STATIC_URL.
    #[arg(long, env = "GTFS_STATIC_URL", conflicts_with = "gtfs_path")]
    pub gtfs_url: Option<String>,

    /// Local GTFS zip path(s) (dev / fixture / CI-staging mode). Repeatable:
    /// pass `--gtfs-path a.zip --gtfs-path b.zip` to union several feeds, the
    /// same way a comma-separated `--gtfs-url` unions them. Both routes end in
    /// `pass1::run_pass1_union`, so a multi-feed city (Krakow ships three) is
    /// buildable from local zips without a network fetch — which is what lets
    /// a memory capture stage a pinned or fixture snapshot for ANY city rather
    /// than only single-feed ones.
    ///
    /// Empty when unset; `main` errors if neither this nor `--gtfs-url` is
    /// given. Feed order is the order given and is preserved into the union.
    #[arg(long, conflicts_with = "gtfs_url", action = clap::ArgAction::Append, num_args = 1..)]
    pub gtfs_path: Vec<PathBuf>,

    /// HTTP listen address; mirrors the Node backend contract.
    #[arg(long, default_value = "0.0.0.0:3000")]
    pub listen_addr: SocketAddr,

    /// Seconds to idle after Pass 2 completes (> harness steady window).
    #[arg(
        long = "idle-after-ingestion",
        value_name = "SECONDS",
        default_value_t = 180
    )]
    pub idle_after_ingestion_secs: u64,

    /// Optional persist destination for the completed PTB artifact.
    /// When set, the producer renames the tempfile output to this path after
    /// `finish()` and before flipping the ready flag. Overwrite semantics:
    /// an existing file at `<PATH>` is replaced atomically (rename on the
    /// same filesystem; copy+remove fallback across filesystems). Parent
    /// directories are created with `mkdir -p`. Failure to create the parent
    /// or to rename is a hard-exit — a half-persisted artifact is worse than
    /// no artifact for downstream Phase B consumers.
    #[arg(long, value_name = "PATH")]
    pub out: Option<PathBuf>,

    /// Anchor date for the 90-day service bitmask window (YYYYMMDD, e.g. 20260521).
    /// Day 0 of the bitmask corresponds to this date; the window covers
    /// [anchor, anchor + 90 days). Defaults to today's UTC date so the window
    /// is always a rolling 90-day view from the build moment.
    ///
    /// Pass a fixed value in CI / tests for deterministic output.
    /// Do NOT set this in production — the default (today) is correct.
    #[arg(long, value_name = "YYYYMMDD")]
    pub anchor_date: Option<u32>,

    /// City IANA timezone (e.g. "Europe/Vilnius"). Required for service-day
    /// arithmetic. Mirrored
    /// into `*.meta.json` and `generation.json` as `cityTzIana`.
    /// pt-serve resolves it to a Jiff `TimeZone` for service-day arithmetic;
    /// an unknown name is fail-closed at pt-serve startup.
    #[arg(long, value_name = "IANA_NAME", env = "PT_CITY_TZ_IANA")]
    pub city_tz_iana: Option<String>,

    /// Static UTC offset in seconds at `feedStartDate`'s midnight UTC. Sanity-check only; pt-serve
    /// uses Jiff for runtime arithmetic. Required unless `--city-tz-iana=UTC`. A value of 0 paired
    /// with a non-UTC IANA name is rejected at pt-serve startup.
    #[arg(long, value_name = "SECONDS", env = "PT_CITY_TZ_OFFSET_SECONDS")]
    pub city_tz_offset_seconds: Option<i32>,

    /// Whether to auto-derive GTFS type-4 in-seat transfer rules from block_id.
    /// `auto` (default): derive when the feed has no type-4 entries of its own.
    /// `off`: never derive; rely solely on the feed's transfers.txt.
    #[arg(long, value_enum, default_value_t = DeriveInseat::Auto)]
    pub derive_inseat: DeriveInseat,
}

/// Subcommands. Each one is its own publish/refresh mode.
#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    /// Bind a fresh root, or explicitly migrate an accepted existing root to a
    /// stable deployment identity. Does not fetch, rebuild or change generations.
    BindDataRoot {
        #[arg(long)]
        data_root: PathBuf,
        #[arg(long)]
        identity: String,
        /// Required when migrating an existing current.json.
        #[arg(long)]
        expected_generation: Option<String>,
    },
    /// P4 publish-protocol periodic refresh loop. Each tick acquires
    /// `producer.lock` on the `--data-root`, builds a PTB from one or more
    /// `--gtfs <ZIP>` paths (multi-feed union via `pass1::run_pass1_union`
    /// — needed for Krakow's 3-feed input), writes it into `<data-root>/
    /// .publishing/<sha>/`, validates offline, renames to `<data-root>/
    /// generations/<sha>/`, atomically flips `<data-root>/current.json`,
    /// runs the janitor, and signals pt-serve via `<data-root>/pt-serve.pid`.
    /// After each tick the process sleeps `--refresh-interval-secs` (with
    /// SIGTERM/SIGINT responsiveness via `idle::sleep_until_term`) and
    /// runs the next tick. The process exits only on SIGTERM/SIGINT or a
    /// fatal misconfig (producer.lock conflict). Compose `restart: unless-
    /// stopped` is a panic/OOM safety net only.
    ///
    /// Fault injection: `PT_PRODUCER_FAULT_INJECT={after_step_4 |
    /// between_step_5_and_step_7 | after_step_7_validate_fail |
    /// after_step_9 | after_sighup | mid_rename_copyup | enospc_step_3}`
    /// fires a deterministic abort at the named step (exit code 42).
    #[command(name = "periodic-refresh")]
    PeriodicRefresh {
        /// P4 data root — the directory containing `current.json`,
        /// `last-good.json`, `generations/<sha>/`, and `producer.lock`.
        #[arg(long, value_name = "PATH")]
        data_root: PathBuf,

        /// Operator-supplied city slug. Mirrored into `GenerationManifest::
        /// city_slug`; pt-serve cross-checks against its own `--city` flag.
        #[arg(long, value_name = "SLUG")]
        city: String,

        /// Local GTFS zip path(s) — one or more. Multiple `--gtfs <path>`
        /// invocations are unioned via the same `pass1::run_pass1_union`
        /// path the URL flow uses.
        #[arg(long, value_name = "PATH", action = clap::ArgAction::Append, required = true, num_args = 1..)]
        gtfs: Vec<PathBuf>,

        /// Anchor date override. Same semantics as the top-level arg —
        /// production should NOT set this; CI/tests pin it for determinism.
        #[arg(long, value_name = "YYYYMMDD")]
        anchor_date: Option<u32>,

        /// Pre-built transfers.bin to publish alongside the bundle. The
        /// producer does NOT build this artifact itself (the Node-side
        /// `scripts/build-transfers.mjs` does); we just propagate it
        /// through the producer/consumer contract. If absent, the manifest
        /// records `hasTransfers=false`.
        #[arg(long, value_name = "PATH")]
        transfers: Option<PathBuf>,

        /// Pre-built `address-search.json` to publish alongside the bundle.
        /// Same propagate-only contract as `--transfers`: the producer does
        /// not build the address corpus, it copies the named file into every
        /// staging generation so the sidecar survives each refresh tick and
        /// swaps atomically with the PTB it was published beside. If absent,
        /// the generation carries no address corpus and pt-serve's
        /// `/api/<city>/address-search*` routes answer 404 (a supported
        /// state).
        #[arg(long, value_name = "PATH")]
        address_search: Option<PathBuf>,

        /// osmium GeoJSONSeq walking graph (plain or `.gz`). When set, the
        /// producer BUILDS each generation's `transfers.bin` by pricing that
        /// generation's stops over this graph (pt-build-transfers defaults).
        /// Mutually exclusive with `--transfers`.
        #[arg(long, value_name = "PATH", conflicts_with = "transfers")]
        walking_graph: Option<PathBuf>,

        /// Explicit local per-city OSM input directory generated by
        /// `scripts/build-city-osm-artifacts.mjs`. Supplies
        /// `walking.geojsonseq.gz` (as `--walking-graph`) and
        /// `address-search.fst` (as `--address-search`) when the files exist;
        /// a missing file or directory is a warning. Use --osm-artifact-root
        /// for required managed production inputs. Explicit flags win.
        #[arg(long, value_name = "DIR")]
        city_osm_dir: Option<PathBuf>,

        /// Installed artifact root. Required producer inputs are resolved and
        /// pinned from its activation at each tick; missing data fails readiness.
        #[arg(long, env = "PT_OSM_ARTIFACT_ROOT", value_name = "DIR", conflicts_with_all = ["city_osm_dir", "transfers", "walking_graph", "address_search"])]
        osm_artifact_root: Option<PathBuf>,

        /// Writable lease directory shared with the artifact manager. When set,
        /// each tick holds an OS lock on its resolved release so retention
        /// cannot prune inputs mid-build. Required when the manager prunes.
        #[arg(
            long,
            env = "PT_OSM_LEASE_ROOT",
            value_name = "DIR",
            requires = "osm_artifact_root"
        )]
        osm_lease_root: Option<PathBuf>,

        /// Janitor retention cap. Generations beyond this count (and not
        /// pinned by `current.json` / `last-good.json`) are reaped after
        /// each successful publish. Default 10 — matches pt-serve's
        /// reload-side cap.
        #[arg(long, value_name = "N", default_value_t = 10)]
        max_retained_generations: usize,

        /// Bind address for the optional producer liveness server
        /// (`GET /healthz` = liveness, `GET /readyz` = readiness gated on
        /// first publish success, `GET /metrics` = Prometheus exposition).
        /// When unset, no server is spawned. Production sidecars use
        /// `127.0.0.1:9100`; tests bind to `127.0.0.1:0` to pick an
        /// ephemeral port. With the in-process tick loop, the server stays
        /// bound for the process lifetime — `depends_on: service_healthy`
        /// consumers can gate cleanly on it.
        #[arg(long, value_name = "HOST:PORT")]
        liveness_listen_addr: Option<std::net::SocketAddr>,

        /// Producer refresh interval (seconds). The liveness server's
        /// `/healthz` staleness threshold is `2 × this`. Default 3600
        /// (1 hour) matches the periodic-refresh operator runbook.
        #[arg(long, value_name = "SECONDS", default_value_t = 3600)]
        refresh_interval_secs: u64,

        /// City IANA timezone (e.g. "Europe/Vilnius"). Same semantics as
        /// the top-level flag; see its docs.
        #[arg(long, value_name = "IANA_NAME", env = "PT_CITY_TZ_IANA")]
        city_tz_iana: Option<String>,

        /// Static UTC offset in seconds. Same semantics as the top-level
        /// flag; see its docs.
        #[arg(long, value_name = "SECONDS", env = "PT_CITY_TZ_OFFSET_SECONDS")]
        city_tz_offset_seconds: Option<i32>,

        /// Whether to auto-derive GTFS type-4 in-seat transfer rules from block_id.
        /// Same semantics as the top-level flag.
        #[arg(long, value_enum, default_value_t = DeriveInseat::Auto)]
        derive_inseat: DeriveInseat,
    },

    /// P4 DR escape hatch — republish a cached GTFS zip out-of-band.
    /// Used when the live pipeline is stuck and the operator needs to ship
    /// a known-good cached feed to pt-serve immediately. Runs the SAME
    /// publish protocol as `periodic-refresh` (acquires `producer.lock`,
    /// validates, atomic flip, janitor + SIGHUP) so the on-disk shape is
    /// indistinguishable.
    ///
    /// Differences vs periodic-refresh:
    /// - Input is `--from-cache <zip>` (always a local file).
    /// - `--archive-to <dir>`: copy the current generation + current.json
    ///   to `<dir>/<timestamp>/` BEFORE the new publish, preserving the
    ///   stuck state for forensics.
    #[command(name = "republish")]
    Republish {
        #[arg(long, value_name = "PATH")]
        data_root: PathBuf,

        #[arg(long, value_name = "SLUG")]
        city: String,

        /// Local cached GTFS components, in stable source order. Repeat for unions.
        #[arg(long = "from-cache", value_name = "PATH", required = true)]
        from_cache: Vec<PathBuf>,

        /// Optional forensic archive destination. When set, the current
        /// generation's bundle + `current.json` are copied here under a
        /// timestamped subdirectory BEFORE the new publish flips the
        /// pointer.
        #[arg(long, value_name = "PATH")]
        archive_to: Option<PathBuf>,

        #[arg(long, value_name = "YYYYMMDD")]
        anchor_date: Option<u32>,

        #[arg(long, value_name = "PATH")]
        transfers: Option<PathBuf>,

        /// Pre-built `address-search.json`. Same semantics as the
        /// periodic-refresh flag; pass it here too, or a DR republish
        /// publishes a generation with no address corpus and the routes go
        /// dark until the next periodic tick.
        #[arg(long, value_name = "PATH")]
        address_search: Option<PathBuf>,

        /// osmium GeoJSONSeq walking graph (plain or `.gz`). When set, the
        /// producer BUILDS each generation's `transfers.bin` by pricing that
        /// generation's stops over this graph (pt-build-transfers defaults).
        /// Mutually exclusive with `--transfers`.
        #[arg(long, value_name = "PATH", conflicts_with = "transfers")]
        walking_graph: Option<PathBuf>,

        /// Explicit local per-city OSM input directory generated by
        /// `scripts/build-city-osm-artifacts.mjs`. Supplies
        /// `walking.geojsonseq.gz` (as `--walking-graph`) and
        /// `address-search.fst` (as `--address-search`) when the files exist;
        /// a missing file or directory is a warning. Use --osm-artifact-root
        /// for required managed production inputs. Explicit flags win.
        #[arg(long, value_name = "DIR")]
        city_osm_dir: Option<PathBuf>,

        /// Installed artifact root. Required producer inputs are resolved and
        /// pinned from its activation at each tick; missing data fails readiness.
        #[arg(long, env = "PT_OSM_ARTIFACT_ROOT", value_name = "DIR", conflicts_with_all = ["city_osm_dir", "transfers", "walking_graph", "address_search"])]
        osm_artifact_root: Option<PathBuf>,

        /// Writable lease directory shared with the artifact manager. When set,
        /// each tick holds an OS lock on its resolved release so retention
        /// cannot prune inputs mid-build. Required when the manager prunes.
        #[arg(
            long,
            env = "PT_OSM_LEASE_ROOT",
            value_name = "DIR",
            requires = "osm_artifact_root"
        )]
        osm_lease_root: Option<PathBuf>,

        #[arg(long, value_name = "N", default_value_t = 10)]
        max_retained_generations: usize,

        /// City IANA timezone (e.g. "Europe/Vilnius"). Same semantics as
        /// the top-level flag; see its docs.
        #[arg(long, value_name = "IANA_NAME", env = "PT_CITY_TZ_IANA")]
        city_tz_iana: Option<String>,

        /// Static UTC offset in seconds. Same semantics as the top-level
        /// flag; see its docs.
        #[arg(long, value_name = "SECONDS", env = "PT_CITY_TZ_OFFSET_SECONDS")]
        city_tz_offset_seconds: Option<i32>,

        /// Whether to auto-derive GTFS type-4 in-seat transfer rules from block_id.
        /// Same semantics as the top-level flag.
        #[arg(long, value_enum, default_value_t = DeriveInseat::Auto)]
        derive_inseat: DeriveInseat,
    },

    /// Convert the extractor's JSON address corpus into the packed artifact.
    ///
    /// The extractor (`packages/backend/scripts/extract-addr-fixture.ts`) emits
    /// JSON because it runs osmium from Node. That JSON is an intermediate, not
    /// a deliverable: it repeats every lookup key as an object and is ~4x the
    /// size of the index it describes. This subcommand builds the FST once and
    /// writes the artifact that actually ships, so the JSON never has to be
    /// committed, served, or parsed by a client.
    #[command(name = "pack-address-search")]
    PackAddressSearch {
        /// The extractor's `address-search.json` intermediate. Its
        /// `schemaVersion` is the extract contract's, not the packed
        /// artifact's.
        #[arg(long, value_name = "PATH")]
        input: PathBuf,

        /// Destination `.fst` artifact.
        #[arg(long, value_name = "PATH")]
        out: PathBuf,

        /// City slug recorded in the artifact metadata. Cross-checked against
        /// the input's own `cityId` when it carries one, so a mislabelled
        /// corpus fails here rather than at generation load.
        #[arg(long, value_name = "SLUG")]
        city: Option<String>,
    },

    /// Tile-step-only entry point: build the schedule-tile bundle for a
    /// generation directory that ALREADY holds `bundle.ptb` +
    /// `route-styles.json`, then exit.
    ///
    /// This is the step `periodic-refresh`/`republish` run as their Step 3g,
    /// lifted out so a caller that already has a staged generation does not
    /// have to re-run a whole GTFS ingestion to obtain tiles. It runs the same
    /// `schedule_tiles::build_schedule_tiles` those two modes call, so the
    /// bytes are identical — it is not a second implementation.
    ///
    /// What it deliberately does NOT do: acquire `producer.lock`, validate,
    /// flip `current.json`, run the janitor, signal pt-serve, or touch
    /// `generation.json`. It writes exactly what the tile step writes —
    /// `schedule-tiles/` plus `trip-route.json` / `stop-cell.json` in the
    /// generation root — and prints the artifact hashes so the caller can
    /// record `scheduleTileBundleSha256` / `scheduleTileBundleHash` itself.
    ///
    /// Output protocol matches `schedule-tile-gen.mjs` (its stdout lines are
    /// what `refresh.rs::parse_producer_build_output` parses), so the two are
    /// drop-in comparable:
    ///
    /// ```text
    /// schedule-tile-bundle <sha256> <bytes> <bundleHash>
    /// trip-route.json <sha256> <bytes>
    /// stop-cell.json <sha256> <bytes>
    /// ```
    #[command(name = "build-schedule-tiles")]
    BuildScheduleTiles {
        /// Generation directory holding `bundle.ptb` and `route-styles.json`.
        /// Under the P4 data-root layout this is
        /// `<data-root>/generations/<generationId>`; any directory with those
        /// two files works (the producer's own staging dir, a bench's seeded
        /// data root).
        #[arg(long, value_name = "PATH")]
        gen_dir: PathBuf,

        /// City slug, mirrored into the tile manifest exactly as the publish
        /// modes mirror `--city`.
        #[arg(long, value_name = "SLUG")]
        city: String,

        /// Publication ID for schedule tiles. When generation.json exists it
        /// must match its validated publication identity. Standalone fixture
        /// builds without a manifest may supply a lowercase SHA-256 token;
        /// otherwise they use the PTB content SHA as their local tile token.
        #[arg(long, value_name = "SHA256_HEX")]
        gen_id: Option<String>,
    },
}

// Serialises the env-injection / parse / env-restore dance below so tests that
// run in the same process don't race on shared env state. Without this, two
// parallel test cases that both touch GTFS_STATIC_URL can see each other's
// values mid-parse and produce wrong results.
static PARSE_ENV_LOCK: Mutex<()> = Mutex::new(());

impl Args {
    /// Test entrypoint with explicit env injection. clap's env reader pulls from
    /// the process env, which is shared across tests in the same binary; this
    /// wrapper saves the prior value, applies the test env, parses, then restores.
    pub fn try_parse_from_with_env<I, S>(argv: I, env: &[(&str, &str)]) -> Result<Self, clap::Error>
    where
        I: IntoIterator<Item = S>,
        S: Into<std::ffi::OsString> + Clone,
    {
        let _guard = PARSE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prior: Vec<(String, Option<String>)> = env
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(*k).ok()))
            .collect();
        for (k, v) in env {
            std::env::set_var(k, v);
        }
        // Also clear any env keys mentioned in the test set that have no override.
        // (Covers the case where the test wants to assert behaviour with an env
        // key explicitly absent — pass `("KEY", "")` to set empty; pass no entry
        // to leave the surrounding env intact.)
        let result = Self::try_parse_from(argv);
        for (k, prior_val) in prior {
            match prior_val {
                Some(v) => std::env::set_var(&k, v),
                None => std::env::remove_var(&k),
            }
        }
        result
    }
}
