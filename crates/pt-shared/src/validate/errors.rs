//! Five-class `ValidationError` taxonomy.
//!
//! Every load-path failure surfaces as one of the five public classes —
//! `Producer`, `Structural`, `Operator`, `Engine`, `Io` — so audit-log,
//! telemetry, and the reload runner can dispatch on a stable label without
//! pattern-matching opaque error strings.
//!
//! The structural class is a wrapper around [`pt_core::validate::errors::StructuralError`] (the
//! `no_std` 7-variant taxonomy from pt-core); everything else is `std`-only and carries `String`
//! payloads. The split means the engine/bench harnesses see the SAME structural taxonomy as the
//! server does (one source of truth).
//!
//! ## Why `IoErr` instead of `std::io::Error` directly
//!
//! `ValidationError` is `Clone` (the reload runner clones it into the audit
//! log and the `/ready` snapshot), and `std::io::Error` is not `Clone`. We
//! wrap the relevant fields (`kind` + `to_string()`) in `IoErr` to preserve
//! the platform errno and message without forcing a non-Clone field at the
//! top level.

use pt_core::validate::errors::StructuralError;
use thiserror::Error;

/// The 5-class taxonomy. Use [`ValidationError::cause_label`] when you need a
/// stable string for telemetry; use [`ValidationError::is_fatal`] when the
/// caller needs to decide between "exit non-zero" and "fall back to
/// last-good".
#[derive(Debug, Clone, Error)]
pub enum ValidationError {
    /// Wire-format invariants the *producer* must uphold (hashes, sizes,
    /// generation id grammar, feed-start-date agreement, transfers
    /// consistency, manifest skew).
    #[error("producer error: {0}")]
    Producer(#[from] ProducerError),
    /// Bundle bytes are structurally malformed (magic, version, region
    /// bounds, CSR, PTFT). Mirrors the pt-core 7-variant enum 1:1 so the
    /// bench harnesses share the same vocabulary.
    #[error("structural error: {0}")]
    Structural(StructuralError),
    /// Operator-supplied configuration mismatch (wrong city, unsupported
    /// manifest schema version, missing transfers file). These are the
    /// errors a runbook entry can fix without a code change.
    #[error("operator error: {0}")]
    Operator(#[from] OperatorError),
    /// `pt_core::Index::build` failed — the bundle is structurally clean but
    /// the engine could not derive its acceleration structures from it (e.g.
    /// because a CSR invariant the engine demands beyond the structural
    /// checks is violated). Held as a `String` to keep the wrapper Clone-able.
    #[error("engine build error: {0}")]
    Engine(#[from] EngineBuildError),
    /// I/O wrapper that preserves the platform errno and message while
    /// keeping the enum `Clone` (see module docs).
    #[error("io error: {0}")]
    Io(IoErr),
}

/// Clone-able representation of [`std::io::Error`].
#[derive(Debug, Clone, Error)]
#[error("{kind:?}: {msg}")]
pub struct IoErr {
    pub kind: std::io::ErrorKind,
    pub msg: String,
}

impl From<std::io::Error> for IoErr {
    fn from(e: std::io::Error) -> Self {
        Self {
            kind: e.kind(),
            msg: e.to_string(),
        }
    }
}

impl From<std::io::Error> for ValidationError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.into())
    }
}

/// Convenience: lift a structural-error from pt-core into the wrapper. The
/// `#[from]` attribute would clash with the `From<StructuralError>` blanket
/// (thiserror generates one too), so we provide a manual impl.
impl From<StructuralError> for ValidationError {
    fn from(e: StructuralError) -> Self {
        Self::Structural(e)
    }
}

/// Producer-controlled invariants. A failure here means the on-disk artifact
/// disagrees with itself: the loader is reading a torn write, the producer
/// published with a stale carryover, or the manifest's content-derived
/// fields don't match the bytes they describe.
#[derive(Debug, Clone, Error)]
pub enum ProducerError {
    /// `manifest.generation_id` does NOT equal the lowercase-hex SHA-256 of the bundle bytes.
    #[error("generationId does not bind bundleSha256 and publicationInputsSha256")]
    GenerationIdHashMismatch,
    /// Bundle bytes' SHA-256 disagrees with `manifest.bundle_sha256`.
    #[error("bundle hash mismatch: expected {expected}, computed {computed}")]
    BundleHashMismatch { expected: String, computed: String },
    /// Bundle size on-disk disagrees with `manifest.bundle_size_bytes`.
    #[error("bundle size mismatch: expected {expected}, on-disk {actual}")]
    BundleSizeMismatch { expected: u64, actual: u64 },
    /// Transfers bytes' SHA-256 disagrees with `manifest.transfers_sha256`.
    #[error("transfers hash mismatch: expected {expected}, computed {computed}")]
    TransfersHashMismatch { expected: String, computed: String },
    /// Transfers size disagrees with `manifest.transfers_size_bytes`.
    #[error("transfers size mismatch: expected {expected}, on-disk {actual}")]
    TransfersSizeMismatch { expected: u64, actual: u64 },
    /// `manifest.has_transfers == false` but a `transfers.bin` was found —
    /// a carryover from a previous publish the producer forgot to GC.
    #[error("stale transfers carryover")]
    StaleTransfersCarryover,
    /// `manifest.created_at` is more than the configured tolerance ahead of
    /// `now()`. Either the producer's clock is wrong, the server's clock is
    /// wrong, or someone hand-edited the manifest.
    #[error("createdAt clock skew: createdAt={created_at}, now={now}")]
    CreatedAtClockSkew { created_at: String, now: String },
    /// `manifest.feed_start_date` (YYYYMMDD) disagrees with the same field
    /// in the PTB header.
    #[error("feedStartDate mismatch: manifest={manifest}, bundle={bundle}")]
    FeedStartDateMismatch { manifest: u32, bundle: u32 },
    /// `manifest.created_at` is not parseable as the strict RFC 3339 subset
    /// (`YYYY-MM-DDTHH:MM:SSZ`). The producer must emit exactly this form.
    #[error("createdAt not RFC3339 ({0:?})")]
    CreatedAtMalformed(String),
    /// PTB header `city_tz_offset_seconds` disagrees with the bundled tzdb's
    /// computed offset for the manifest's `cityTzIana` at `feed_start_date`.
    /// Catches: producer set the offset wrong, IANA name is wrong, or the
    /// producer never wrote [28..32].
    /// Cities legitimately at UTC+0 (Reykjavik, Accra) round-trip cleanly
    /// because both sides agree on 0.
    #[error("PTB header offset {found_secs}s != Jiff computed offset {expected_secs}s for tz {iana} at feed_start_date {ymd}")]
    TzOffsetMismatch {
        iana: String,
        ymd: u32,
        found_secs: i32,
        expected_secs: i32,
    },
    /// Manifest `cityTzIana` is not a supported IANA name. Either the producer shipped a typo
    /// (`Europe/Vilnious`) or a new city slug that pt-serve's city→tz table doesn't carry yet
    /// (intentional fail-closed per).
    #[error("manifest cityTzIana {iana} is not a supported IANA name")]
    UnknownIana { iana: String },
    /// A present `departures-idx.bin` (DPIX) sidecar failed to parse/validate
    /// against the bundle at load: a header magic/truncation defect, a
    /// malformed CSR, OR a namespace-SHA mismatch vs the bundle's recomputed
    /// Trips/Stops interner SHAs. A DPIX that is on disk but inconsistent
    /// with the bundle is producer-side corruption — same severity as a corrupt
    /// PTB — so the generation is REJECTED rather than served degraded. (An
    /// ABSENT DPIX is NOT this error: the consumer degrades to `None`.)
    #[error("departures-idx.bin invalid: {reason}")]
    DeparturesIdxInvalid { reason: String },
}

/// Operator-controlled invariants. A failure here is fix-by-config rather
/// than fix-by-republish.
#[derive(Debug, Clone, Error)]
pub enum OperatorError {
    /// `manifest.city_slug` doesn't match the `--city` flag this pt-serve
    /// was started with. Fail closed — adopting would silently serve the
    /// wrong city's data.
    #[error("wrong city: expected {expected}, found {found}")]
    WrongCity { expected: String, found: String },
    /// `manifest.manifest_schema_version` outside
    /// `MANIFEST_SCHEMA_VERSION_MIN..=MANIFEST_SCHEMA_VERSION_MAX`.
    /// The only currently-fatal class — see [`ValidationError::is_fatal`].
    #[error("unsupported manifest schema version: {0}")]
    UnsupportedManifestSchemaVersion(u32),
    /// `manifest.has_transfers == true` but `transfers.bin` is not on
    /// disk. The pairing the producer promised is broken.
    #[error("missing transfers file (hasTransfers=true but file absent)")]
    MissingTransfersFile,
    /// The tz cross-check needs an IANA name but the manifest omitted the optional
    /// `cityTzIana` field (a generation published before the producer started
    /// emitting it) AND the operator didn't supply `--city-tz-iana-default`.
    /// Fix-by-config. (`cityTzIana` is an optional Postel-rule field — the
    /// GenerationManifest schemaVersion stays 1; its absence is not a schema
    /// downgrade.)
    #[error("manifest omitted cityTzIana and no --city-tz-iana-default supplied for city {city}")]
    TzIanaUnresolved { city: String },
}

/// `pt_core::Index::build` failed for a reason the structural validator
/// could not catch (e.g. a per-engine invariant the wire format permits but
/// the engine rejects).
#[derive(Debug, Clone, Error)]
#[error("Index::build failed: {reason}")]
pub struct EngineBuildError {
    pub reason: String,
}

impl ValidationError {
    /// Stable telemetry label. Returns one of: `"producer"`, `"structural"`,
    /// `"operator"`, `"engine"`, `"io"`.
    pub fn cause_label(&self) -> &'static str {
        match self {
            Self::Producer(_) => "producer",
            Self::Structural(_) => "structural",
            Self::Operator(_) => "operator",
            Self::Engine(_) => "engine",
            Self::Io(_) => "io",
        }
    }

    /// True iff the caller MUST exit non-zero rather than fall back to
    /// last-good. Currently only the unsupported-manifest-schema-version
    /// case — every other class lets the runner try last-good first (a
    /// fresh validator on the older generation may succeed).
    pub fn is_fatal(&self) -> bool {
        matches!(
            self,
            Self::Operator(OperatorError::UnsupportedManifestSchemaVersion(_))
        )
    }
}
