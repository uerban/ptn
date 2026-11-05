import { loadGtfs } from "./loader.js";
import { loadFromPtb } from "./loadFromPtb.js";
import { GtfsStore } from "./store.js";
import { validateCityBbox } from "./validateCityBbox.js";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import type { FastifyBaseLogger } from "fastify";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { BundleManifest, SubdivisionPlan } from "@pt/shared";
import { buildAndPublishBundle } from "./buildAndPublishBundle.js";
import type { ComputeBundleHashFeedFile } from "./computeBundleHash.js";
import { metricsRegistry } from "../metrics/registry.js";

const INIT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

interface SchedulerOptions {
  gtfsUrls: string[];
  refreshIntervalHours: number;
  logger: FastifyBaseLogger;
  minTripsPerRoute?: number;
  /**
   * CITY_ID for this scheduler — used to validate that the loaded GTFS
   * feed actually corresponds to the configured city. Catches env drift
   * (wrong GTFS_STATIC_URL, swapped containers, stale volumes) at boot.
   * When omitted, validation is skipped.
   */
  cityId?: string;
  /**
   * Root directory for tiled-stop-schedule bundles. Bundles are stored at
   * `<scheduleTileDataDir>/<bundleHash>/...` and the manifest lives at
   * `<scheduleTileDataDir>/manifest.json`. When omitted, the scheduler
   * accessors `getBundleDataDir()` / `getCurrentBundleHash()` are still
   * callable but `getCurrentBundleHash()` will always return null, AND the
   * post-swap bundle build is skipped (no tiles produced).
   */
  scheduleTileDataDir?: string;
  /**
 * GTFS-RT feed URLs in feed-source order. Threaded into `computeBundleHash` so RT feed rotation
 * invalidates the bundle hash. Pass `[]` explicitly when a city has no RT feed — required (not
 * optional) so a forgotten env var can't silently coerce "RT undeclared" to "RT empty" and skip
 * hash invalidation forever.
 */
  rtFeedUrls: readonly string[];
  /**
   * Bundles to keep on disk after the janitor sweep. Defaults to 2 (per spec
   * ); production currently uses the default. Validated at construction
   * — `< 1` would let `buildAndPublishBundle`'s sweep delete the
   * just-written bundle, leaving the manifest pointing at a missing dir.
   */
  keepBundleCount?: number;
  /**
   * When set and the path exists on disk, the initial load reads the Phase B
   * Rust-emitted PTB bundle + `.meta.json` + `.shapes.json` sidecars instead
   * of downloading + parsing GTFS zips. The refresh loop continues to use
   * `loadGtfs` (the sidecar runs once at container start; subsequent feed
   * updates fall back to network-fetch until Plan 3's `ptn-serve` ships).
   */
  ptnBundlePath?: string;
}

/**
 * One content-keyed parse of `manifest.json`, shared by both tile routes and the
 * manifest route so a refresh between reads can't tear `bundleHash` vs. the
 * subdivision plan. `contentEtag = sha256(text).slice(0,32)` (mirrors
 * raptorBundle.ts's content-hash) — the served ETag survives attr-preserving
 * renames. `parsed` is the full manifest for callers that need other fields.
 */
export interface ManifestSnapshot {
  bundleHash: string;
  subdivisions?: Record<string, SubdivisionPlan>;
  contentEtag: string;
  parsed: BundleManifest;
}

export class GtfsScheduler {
  private store: GtfsStore;
  private etags: Map<string, string> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: SchedulerOptions;
  private _lastError: string | null = null;
  private _initAttempts = 0;
  // Latches once a PTB load throws (corrupt/incompatible bundle on disk).
  // Without it, every retry re-evaluates `existsSync(ptnBundlePath)`, takes
  // the PTB branch again, and fails identically — an infinite retry loop
  // that never reaches the working network path even though the bundle file
  // is the problem. The latch routes subsequent loads to loadGtfs instead.
  private _ptbFailed = false;
  private _loaderMode: "ptb" | "ptb_fallback" | "gtfs-network" = "gtfs-network";
  /** YYYYMMDD day-0 of the 90-day bitmask window from the last PTB load; null otherwise. */
  private _serviceWindowAnchor: number | null = null;
  private _everBuilt = false;
  private _lastBuildStatus: "success" | "failure" | null = null;
  private _lastSuccessMs: number | null = null;
  private _lastFailureMs: number | null = null;
  private _oversizedLeafCount = 0;
  // Per-process retained manifest parse. `_manifestSnapshot` is the last GOOD parse;
  // `_manifestStat` is the cheap (mtime,size) pre-gate.
  private _manifestSnapshot: ManifestSnapshot | null = null;
  private _manifestStat: { mtimeMs: number; size: number } | null = null;
  // Async-build re-entrancy guard. The sync build could never overlap; an async
  // build can be in flight when the next schedulePublishBundle() fires (init /
  // refresh). The check-and-set is SYNCHRONOUS at dispatch (gates scheduling,
  // not execution); the coalesce slot holds the latest {canonical, feedFiles}.
  private _buildInFlight = false;
  private _buildPending: {
    canonical: CanonicalStore;
    feedFiles: readonly ComputeBundleHashFeedFile[];
  } | null = null;
  private _stopped = false;

  constructor(options: SchedulerOptions) {
    // An empty gtfsUrls is only valid in PTB mode: index.ts deliberately
    // resolves an empty GTFS_STATIC_URL to `[]` when PT_BUNDLE_PATH is set
    // (see resolveGtfsStaticUrls) so that a failed PTB load fails CLOSED at
    // /ready (loadViaNetwork refuses the empty-URL network load) rather than
    // silently downloading an unrelated default feed. Crashing at construction
    // here would defeat that — the server could never come up to report
    // not-ready. In pure-network mode (no bundle path) an empty URL set is a
    // genuine misconfiguration, so keep failing fast there.
    if (options.gtfsUrls.length === 0 && !options.ptnBundlePath) {
      throw new Error(
        "GtfsScheduler requires at least one URL in gtfsUrls (unless PT_BUNDLE_PATH is set, in which case an empty set fails closed at load time)",
      );
    }
    // Validate at construction so a misconfigured `keepBundleCount` fails
    // at boot instead of every refresh interval logging a misleading
    // "buildAndPublishBundle failed" line. The orchestrator throws the
    // same RangeError at runtime if this slipped through, but we'd rather
    // crash-loop the pod than emit a transient-looking log forever.
    if (options.keepBundleCount !== undefined &&
        (!Number.isInteger(options.keepBundleCount) || options.keepBundleCount < 1)) {
      throw new RangeError(
        `GtfsScheduler: keepBundleCount must be an integer >= 1, got ${options.keepBundleCount}`,
      );
    }
    this.options = options;
    this.store = new GtfsStore(); // empty, not ready
  }

  getStore(): GtfsStore {
    return this.store;
  }

  /**
   * The city slug this scheduler is configured for (e.g. "vilnius").
   * Returns an empty string when `cityId` was not provided.
   */
  getCityId(): string {
    return this.options.cityId ?? "";
  }

  /**
   * Root directory where tiled-stop-schedule bundles are stored.
   * Each bundle lives at `<bundleDataDir>/<bundleHash>/` and the
   * manifest is at `<bundleDataDir>/manifest.json`.
   *
   * Returns the configured `scheduleTileDataDir`, or an empty string
   * when the option was not provided (callers should guard on this).
   */
  getBundleDataDir(): string {
    return this.options.scheduleTileDataDir ?? "";
  }

  /**
   * ONE content-keyed parse of `manifest.json`, shared by both tile routes and
   * `gtfsManifest` so a refresh between reads cannot tear hash vs. plan. The snapshot
   * IDENTITY is keyed on `sha256(text).slice(0,32)` (the `contentEtag`) so the served
   * ETag survives attr-preserving renames (mirrors raptorBundle.ts content-hash). `stat`
   * is a cheap pre-gate to AVOID re-reading on the hot path: an unchanged (mtime,size)
   * returns the retained parse WITHOUT re-hashing — a deliberate cost/safety trade. The
   * only case this misses is an attr-preserving same-size content rewrite, which the
   * producer NEVER does (it atomic-renames a fresh new-hash dir, always bumping mtime);
   * re-hashing every request would re-add the per-request O(file-size) cost the snapshot
   * exists to remove. Do NOT "tighten" this to hash-on-every-call. On a transient
   * read/parse error returns the PREVIOUS good snapshot; only a true cold start returns
   * null. Per-process slot (one GtfsScheduler).
   */
  getManifestSnapshot(): ManifestSnapshot | null {
    const dir = this.options.scheduleTileDataDir;
    if (!dir) return null;
    const manifestPath = join(dir, "manifest.json");
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(manifestPath);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return this._manifestSnapshot; // ENOENT etc. — keep previous-good, else cold null
    }
    if (
      this._manifestSnapshot &&
      this._manifestStat &&
      this._manifestStat.mtimeMs === st.mtimeMs &&
      this._manifestStat.size === st.size
    ) {
      return this._manifestSnapshot;
    }
    let text: string;
    let parsed: BundleManifest;
    try {
      text = readFileSync(manifestPath, "utf8");
      parsed = JSON.parse(text) as BundleManifest;
    } catch (err) {
      this.options.logger.warn(
        { err },
        "getManifestSnapshot: read/parse failed; serving previous-good snapshot",
      );
      return this._manifestSnapshot;
    }
    const contentEtag = createHash("sha256").update(text).digest("hex").slice(0, 32);
    const snapshot: ManifestSnapshot = {
      bundleHash: parsed.bundleHash,
      subdivisions: parsed.subdivisions,
      contentEtag,
      parsed,
    };
    this._manifestSnapshot = snapshot;
    this._manifestStat = st;
    return snapshot;
  }

  /**
   * Read the current bundle hash from the manifest snapshot.
   * Returns `null` when:
   *   - `scheduleTileDataDir` was not configured, or
   *   - no manifest has ever been parsed (first deploy / build in progress).
   *
   * Backed by `getManifestSnapshot()` so it reads the SAME parse the tile and
   * manifest routes see — call it per-request, not in a hot loop.
   */
  getCurrentBundleHash(): string | null {
    return this.getManifestSnapshot()?.bundleHash ?? null;
  }

  /** The last GOOD bundle hash this process parsed, even if the current on-disk
   *  manifest is mid-rename/corrupt. `getManifestSnapshot` has already refreshed the
   *  retained slot to previous-good on a transient error, so this just reads it.
   *  Null only on true cold start. */
  getLastKnownBundleHash(): string | null {
    this.getManifestSnapshot();
    return this._manifestSnapshot?.bundleHash ?? null;
  }

  /**
   * Hydrate `bundle_last_success_timestamp_seconds` from the on-disk
   * manifest. The gauge is process-local — without this, a routine restart
   * resets the metric to 0 and the dashboard goes red until the next
   * successful build (which can be `refreshIntervalHours` away). Calling
   * this once at startup keeps the gauge reflecting the on-disk artifact.
   * No-op when the manifest is absent, or its `generatedAt` is missing,
   * non-finite (NaN/Infinity), or non-positive. Read/parse errors are
   * logged at warn level so the operator gets a breadcrumb when an
   * existing manifest can't be loaded — the dashboard going red on
   * restart with no log line was the silent-failure shape this whole PR
   * is closing.
   */
  hydrateBundleLastSuccessGauge(): void {
    const dir = this.options.scheduleTileDataDir;
    if (!dir) return;
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) return;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
      if (Number.isFinite(manifest.generatedAt) && manifest.generatedAt > 0) {
        metricsRegistry.bundleLastSuccessTimestampSeconds.set(manifest.generatedAt / 1000);
        metricsRegistry.bundleEverBuilt.set(1);
        this._everBuilt = true;
        this._lastSuccessMs = manifest.generatedAt;
      }
      // Rehydrate the DEGRADATION signal (oversized-leaf count) from the on-disk
      // plan so a restarted-but-degraded city reports its oversized state
      // immediately, not 0 until the next build. Mirrors the staleness-gauge
      // rehydrate above. The trend gauges (max_leaf_bytes / leaves_per_bundle) are
      // deliberately NOT rehydrated here: the manifest records only subdivision
      // leaves, not the bare under-cap cells, so a subdivided-only value would
      // understate them (e.g. leaves_per_bundle would read ~2 instead of ~N). They
      // are build-measured and self-correct on the next successful publish.
      if (manifest.subdivisions) {
        const oversized = Object.values(manifest.subdivisions)
          .flatMap((p) => p.leaves)
          .filter((l) => l.oversized).length;
        this._oversizedLeafCount = oversized;
        metricsRegistry.scheduleTileOversizedLeaves.set({ city: this.options.cityId ?? "" }, oversized);
      }
    } catch (err) {
      this.options.logger.warn(
        { err, manifestPath },
        "hydrateBundleLastSuccessGauge: manifest exists but could not be read or parsed; gauge stays at 0 until next successful build",
      );
    }
  }

  /** Last init/load error message, null when healthy. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Number of init attempts so far. */
  get initAttempts(): number {
    return this._initAttempts;
  }

  /**
   * Which ingestion path was actually used on the most recent successful load.
   * - `"ptb"`: PTB sidecar bundle loaded successfully (zero network I/O).
   * - `"ptb_fallback"`: PTB load threw; fell back to the network GTFS path.
   * - `"gtfs-network"`: network GTFS path used (no bundle configured or bundle
   *   absent when `existsSync` was checked).
   *
   * Useful for operator dashboards and health probes: surfaced at
   * `/api/health/ready` as `ingestionPath`.
   */
  get loaderMode(): "ptb" | "ptb_fallback" | "gtfs-network" {
    return this._loaderMode;
  }

  /**
   * Day-0 of the 90-day service-bitmask window as a YYYYMMDD integer (e.g.
   * 20260501). Non-null only when the last successful load was a PTB sidecar
   * load (`loaderMode === "ptb"`). Null for network-GTFS and ptb_fallback
   * loads where no pre-computed bitmask window anchor applies.
   *
   * Surfaced at `/api/health/ready` as `serviceWindowAnchor` for operator
   * dashboards to detect stale bitmask windows before departures go empty.
   */
  get serviceWindowAnchor(): number | null {
    return this._serviceWindowAnchor;
  }

  /**
   * Schedule-tile bundle build outcome, surfaced at `/api/health/ready` as
   * `scheduleBundle`. `configured` is false when no `scheduleTileDataDir` is
   * set (PTB/pt-serve deployments that intentionally never build tiles) — an
   * operator must not read that as "broken". `everBuilt` is true once a usable
   * bundle was published this process OR hydrated from a manifest; it is the
   * signal that distinguishes never-built (the Paris incident) from
   * built-then-a-later-refresh-failed (a prior bundle still serves).
   */
  get bundleBuildState(): {
    configured: boolean;
    everBuilt: boolean;
    lastBuildStatus: "success" | "failure" | null;
    lastSuccessMs: number | null;
    lastFailureMs: number | null;
    oversizedLeafCount: number;
  } {
    return {
      configured: Boolean(this.options.scheduleTileDataDir),
      everBuilt: this._everBuilt,
      lastBuildStatus: this._lastBuildStatus,
      lastSuccessMs: this._lastSuccessMs,
      lastFailureMs: this._lastFailureMs,
      oversizedLeafCount: this._oversizedLeafCount,
    };
  }

  /**
   * Attempt initial GTFS load. On failure, logs detailed error and
   * schedules background retries with exponential backoff — the server
   * stays up so other endpoints and the rest of the stack keep working.
   */
  async init(): Promise<void> {
    const { logger, gtfsUrls } = this.options;
    logger.info({ urls: gtfsUrls, feedCount: gtfsUrls.length }, "Loading GTFS feed(s)...");

    try {
      await this.loadOnce();
      this.startRefreshLoop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      logger.error(
        { err, urls: gtfsUrls, attempt: this._initAttempts },
        "GTFS initial load failed — server stays up, will retry in background",
      );
      this.scheduleRetry();
    }
  }

  private async loadOnce(): Promise<void> {
    this._initAttempts++;
    const { gtfsUrls, minTripsPerRoute, ptnBundlePath, logger } = this.options;

    let result: Awaited<ReturnType<typeof loadGtfs>>;
    if (ptnBundlePath && !this._ptbFailed && existsSync(ptnBundlePath)) {
      logger.info({ ptnBundlePath }, "Loading GTFS via PTB sidecar (zero network I/O)");
      try {
        result = await loadFromPtb(ptnBundlePath, minTripsPerRoute ?? 0);
        this._loaderMode = "ptb";
        this._serviceWindowAnchor = result.feedStartDate ?? null;
      } catch (err) {
        // A present-but-broken bundle (corrupt/truncated/schema drift) must
        // not brick boot: latch so future loads skip PTB, then fall back to
        // the network path in this same attempt rather than burning a retry.
        this._ptbFailed = true;
        logger.error(
          { err, ptnBundlePath },
          "PTB sidecar load failed — falling back to network GTFS for this and all subsequent loads this process",
        );
        result = await this.loadViaNetwork(gtfsUrls, undefined, minTripsPerRoute ?? 0);
        this._loaderMode = "ptb_fallback";
      }
    } else {
      if (ptnBundlePath && !existsSync(ptnBundlePath)) {
        // Operator configured a bundle path but the file isn't there yet (e.g.
        // the sidecar hasn't finished writing, or a wrong path was supplied).
        // Warn so the operator sees a breadcrumb without grepping for the
        // "Loading GTFS via PTB sidecar" line that never appeared.
        logger.warn(
          { ptnBundlePath },
          "PT_BUNDLE_PATH is configured but the file does not exist — using network GTFS path",
        );
      }
      result = await this.loadViaNetwork(gtfsUrls, undefined, minTripsPerRoute ?? 0);
      this._loaderMode = "gtfs-network";
    }
    if (!result) {
      throw new Error("Initial GTFS load returned 304 (no etag provided)");
    }

    this.validateCity(result.canonical);

    this.etags = result.etags;
    // generationDir: the producer's published generation directory — only
    // meaningful when THIS load actually took the PTB path (ptb_fallback and
    // gtfs-network have no producer generation to read colors/anchors from).
    const generationDir = this._loaderMode === "ptb" && ptnBundlePath ? dirname(ptnBundlePath) : undefined;
    this.store.swap(result.indexes, result.canonical, result.routingInput, this.options.minTripsPerRoute ?? 0, generationDir);
    this.store.setShapes(result.shapes ?? []);
    this._lastError = null;

    let routeCount = 0;
    result.canonical.iterRoutes(() => { routeCount++; });
    this.options.logger.info(
      {
        stopCount: result.canonical.stopCount,
        routeCount,
        feedCount: gtfsUrls.length,
        shapeCount: result.shapes?.length ?? 0,
        droppedShapes: result.droppedShapes ?? 0,
      },
      "GTFS feed(s) loaded",
    );

    this.schedulePublishBundle(result.canonical, result.feedFiles);
  }

  /**
   * Network-load gate. Refuses to call `loadGtfs` with an empty URL set so PTB
   * mode + an unconfigured fallback (empty GTFS_STATIC_URL) fails CLOSED.
   *
   * `loadGtfs` already throws on `[]`, but routing through here keeps the
   * fail-closed contract explicit and self-documenting at the call sites, and
   * decouples it from `loadGtfs`'s internal precondition (which exists for a
   * different reason). The caller (`loadOnce`) is wrapped by `init`/retry,
   * which catches, logs "server stays up, will retry", and reschedules — so a
   * throw here means /ready stays not-ready until a real feed is configured,
   * never a silent boot on an unrelated default city.
   */
  private async loadViaNetwork(
    gtfsUrls: string[],
    etags: Map<string, string> | undefined,
    minTripsPerRoute: number,
  ): Promise<Awaited<ReturnType<typeof loadGtfs>>> {
    if (gtfsUrls.length === 0) {
      // Fail closed: no operator-configured GTFS_STATIC_URL and PTB load is
      // unavailable. Serving an unrelated default feed would be worse than not
      // serving — let the load fail so /ready stays not-ready and the misconfig
      // is visible, rather than silently coming up on the wrong city.
      throw new Error(
        "fail-closed: PTB load unavailable and no GTFS_STATIC_URL configured — refusing to serve a default/unrelated feed",
      );
    }
    return loadGtfs(gtfsUrls, etags, minTripsPerRoute);
  }

  /**
   * Schedule the tile-bundle build via `setImmediate`, behind a SYNCHRONOUS
   * re-entrancy gate. The build is async (`fs/promises` I/O + a per-tile
   * `setImmediate` yield); brotli q=11 stays SYNCHRONOUS on the main thread
   * (see `scheduleTileBrotli.ts`), so the loop drains between tiles instead of
   * freezing for the whole build. The gate serializes overlapping triggers
   * (init / refresh) and coalesces them to the latest.
   *
   *   1. The `setImmediate` defer: decouples the build's own start from the
   *      synchronous `swap()`/`schedulePublishBundle()` call path so slow
   *      disk + brotli work never runs inline in the swap()'s caller's stack.
   *      The resolver snapshot is still taken HERE (inside this setImmediate,
   *      before the first await), not at dispatch — not because color config
   *      needs time to populate (`GtfsStore.swap()` now computes it
   *      synchronously, so it's already final by dispatch time), but so each
   *      COALESCED re-dispatch (see #2) snapshots its own build's current
   *      resolvers in its own prologue rather than reusing one snapshot taken
   *      at the earliest of several coalesced dispatches. Because color isn't
   *      a bundleHash input, a torn bundle would never be refetched — hence
   *      the snapshot.
   *
   *   2. Synchronous re-entrancy gate: two calls in one tick must not both
   *      observe `_buildInFlight === false` and both queue a build. The
   *      check-and-set runs BEFORE the setImmediate is scheduled.
   */
  private schedulePublishBundle(
    canonical: CanonicalStore,
    feedFiles: readonly ComputeBundleHashFeedFile[],
  ): void {
    const { scheduleTileDataDir, cityId, logger, minTripsPerRoute, rtFeedUrls, keepBundleCount } = this.options;
    if (!scheduleTileDataDir || this._stopped) return;

    // Producer-side tile build (interim spike-killer). When PT_SCHEDULE_TILE_SOURCE=producer the
    // schedule-tile + rt-tile routes serve and advertise the bundle the PRODUCER already built into
    // the published generation dir, so the backend must NOT also build its own in-process copy —
    // that build is the GTFS-index consumer (CanonicalStore) we are shedding. Skip the build
    // entirely; the scheduler still does everything else (the routing swap, etc.). The `backend`
    // default path is byte-for-byte unchanged. Read the env on each call (not cached at
    // construction) so a test/operator can toggle it without reconstructing the scheduler; this is
    // a once-per-refresh non-hot path.
    if (process.env.PT_SCHEDULE_TILE_SOURCE === "producer") return;

    // Synchronous re-entrancy gate (gates SCHEDULING, not execution): two calls
    // in one tick must not both observe `false` and both queue a build.
    if (this._buildInFlight) {
      metricsRegistry.bundleBuildCoalescedTotal.inc();
      this._buildPending = { canonical, feedFiles };
      return;
    }
    this._buildInFlight = true;

    setImmediate(async () => {
      // stop() may have landed AFTER this build was gated (sync `_buildInFlight`
      // = true above) but BEFORE this callback runs. Abort before any
      // snapshot/build/disk work so a gated-but-not-yet-started build does NOT
      // launch after stop() — matching the contract that only a build already
      // past its first await completes its atomic swap. Release the flag and
      // drop any coalesced slot (frees the held CanonicalStore).
      if (this._stopped) {
        this._buildInFlight = false;
        this._buildPending = null;
        return;
      }
      // Snapshot resolvers HERE (build prologue): `GtfsStore.swap()` computes
      // color config synchronously, so the maps are already final by the time
      // this callback runs (no FIFO-with-another-setImmediate dependency);
      // this is still before the first await, so a mid-build refresh swap()
      // cannot tear the snapshot. The snapshot reads `this.store`,
      // which still holds THIS build's `canonical`: swap()+schedulePublishBundle()
      // are synchronous and adjacent at every call site (init/refresh), and
      // refreshes fire hours apart, so no swap() can intervene in the
      // schedule→prologue window. (If a fast/manual refresh trigger is ever
      // added, bind the snapshot to the canonical's generation — see
      // the bundle build followups notes.)
      const resolved = this.store.snapshotRouteResolvers();
      // hrtime.bigint() is monotonic — wall-clock NTP steps mid-build won't
      // produce negative durations. Captured per-build-execution (each
      // coalesced build re-enters here with its own start).
      const buildStartHr = process.hrtime.bigint();
      try {
        const result = await buildAndPublishBundle({
          canonical,
          cityId: cityId ?? "",
          dataDir: scheduleTileDataDir,
          feedFiles,
          rtFeedUrls,
          minTripsPerRoute: minTripsPerRoute ?? 0,
          keepBundleCount: keepBundleCount ?? 2,
          resolveRouteColor: resolved.resolveRouteColor,
          resolveRouteSubMode: resolved.resolveRouteSubMode,
        });
        const durationMs = Number(process.hrtime.bigint() - buildStartHr) / 1e6;
        metricsRegistry.bundleBuildTotal.inc({ status: "success" });
        metricsRegistry.bundleBuildDurationSeconds.observe({ status: "success" }, durationMs / 1000);
        metricsRegistry.bundleLastSuccessTimestampSeconds.set(Date.now() / 1000);
        metricsRegistry.bundleEverBuilt.set(1);
        this._everBuilt = true;
        this._lastBuildStatus = "success";
        this._lastSuccessMs = Date.now();
        // Defensive read: existing tests / older buildAndPublishBundle results may
        // omit stats/subdivisions; never let a missing field flip success→failure.
        const stats = result.stats ?? { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 };
        const subdivisions = result.subdivisions ?? {};
        this._oversizedLeafCount = stats.oversizedLeaves;
        const city = cityId ?? "";
        metricsRegistry.scheduleTileOversizedLeaves.set({ city }, stats.oversizedLeaves);
        metricsRegistry.scheduleTileMaxLeafBytes.set({ city }, stats.maxLeafBytes);
        metricsRegistry.scheduleTileLeavesPerBundle.set({ city }, result.tilesWritten);
        if (stats.oversizedLeaves > 0) {
          metricsRegistry.scheduleTileOversizedLeafTotal.inc({ city }, stats.oversizedLeaves);
        }
        logger.info(
          {
            bundleHash: result.bundleHash,
            tilesWritten: result.tilesWritten,
            kept: result.janitor.kept,
            deleted: result.janitor.deleted,
            durationMs,
            subdivision: {
              subdividedCells: stats.subdividedCells,
              maxDepth: stats.maxDepth,
              oversizedLeaves: stats.oversizedLeaves,
              maxLeafBytes: stats.maxLeafBytes,
            },
          },
          "Bundle published",
        );
        for (const [cellKey, plan] of Object.entries(subdivisions)) {
          const oversized = plan.leaves.filter((l) => l.oversized);
          // Classification: a single oversized leaf holding the whole cell is the
          // mega-station smell; multiple oversized leaves across quadrants is broad
          // downtown density. Lets ops tell a feed-data issue from genuine density.
          const classification =
            oversized.length === 0 ? "fully-subdivided"
            : plan.leaves.length === 1 ? "single-mega-station"
            : "broad-density";
          logger.warn(
            {
              cellKey,
              leafCount: plan.leaves.length,
              oversizedLeafCount: oversized.length,
              // Guard the spread against an empty leaves array (a defensive plan).
              maxLeafBytes: plan.leaves.length ? Math.max(...plan.leaves.map((l) => l.compressedBytes)) : 0,
              classification,
            },
            "Schedule-tile cell subdivided (over-cap)",
          );
        }
        // Soft ceiling (not abort): a pathological many-dense-cell feed. The cell
        // count comes straight from the build stats (cells.size) — no arithmetic
        // reconstruction from tilesWritten + plan leaf counts.
        const cellCount = stats.cellCount;
        if (cellCount > 0 && result.tilesWritten > 4 * cellCount) {
          logger.warn(
            { tilesWritten: result.tilesWritten, cellCount },
            "Schedule-tile bundle leaf count exceeds 4× its cell count — possible pathological feed density",
          );
        }
      } catch (err) {
        const durationMs = Number(process.hrtime.bigint() - buildStartHr) / 1e6;
        metricsRegistry.bundleBuildTotal.inc({ status: "failure" });
        metricsRegistry.bundleBuildDurationSeconds.observe({ status: "failure" }, durationMs / 1000);
        this._lastBuildStatus = "failure";
        this._lastFailureMs = Date.now();
        logger.error(
          { err, dataDir: scheduleTileDataDir, durationMs },
          "buildAndPublishBundle failed — manifest unchanged, RT/schedule tile routes will keep returning their previous bundle (or 503 if no prior bundle).",
        );
      } finally {
        // Release in `finally` so a throw from the success-arm metric/state
        // writes can't wedge the flag true forever. Drain the coalesce slot
        // non-recursively (re-dispatch re-applies the guard uniformly).
        this._buildInFlight = false;
        const pending = this._buildPending;
        this._buildPending = null;
        if (pending && !this._stopped) {
          this.schedulePublishBundle(pending.canonical, pending.feedFiles);
        }
      }
    });
  }

  /**
   * Verify the loaded feed matches the configured CITY_ID (centroid of stops
   * within 200 km of declared city center). Throws on mismatch — the catch
   * in init()/refresh() then logs + retries/keeps old state.
   * Skipped when cityId is absent or unknown.
   */
  private validateCity(canonical: CanonicalStore): void {
    const { cityId, logger } = this.options;
    if (!cityId) return;
    const check = validateCityBbox(canonical, cityId);
    if (check) {
      logger.info(
        { cityId, distanceKm: check.distanceKm, stopCount: check.stopCount },
        "GTFS feed matches configured city",
      );
    }
  }

  private scheduleRetry(): void {
    const delayIdx = Math.min(this._initAttempts - 1, INIT_RETRY_DELAYS_MS.length - 1);
    // Cold-start (no zip on disk yet, e.g. backend booted while its sidecar worker
    // is still building the first bundle) caps retry delay at 30s so we don't sit
    // idle for 5 min after a handful of early failures. Once the first load
    // succeeds, scheduleRetry isn't called again — the refresh loop takes over.
    const rawDelayMs = INIT_RETRY_DELAYS_MS[delayIdx];
    const delayMs = this.store.isReady() ? rawDelayMs : Math.min(rawDelayMs, 30_000);
    const { logger, gtfsUrls } = this.options;

    logger.warn(
      { nextRetryMs: delayMs, attempt: this._initAttempts, urls: gtfsUrls },
      `Scheduling GTFS init retry in ${Math.round(delayMs / 1000)}s`,
    );

    this.retryTimer = setTimeout(async () => {
      try {
        await this.loadOnce();
        logger.info({ attempt: this._initAttempts }, "GTFS feed loaded after retry");
        this.startRefreshLoop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._lastError = msg;
        logger.error(
          { err, urls: gtfsUrls, attempt: this._initAttempts },
          "GTFS retry failed",
        );
        this.scheduleRetry();
      }
    }, delayMs);
  }

  private startRefreshLoop(): void {
    const intervalMs = this.options.refreshIntervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      // Fire-and-forget the refresh promise but catch its rejection so a
      // synchronous throw before refresh()'s own try (e.g. from a getter)
      // doesn't surface as an unhandledRejection with no log line.
      void this.refresh().catch((err) =>
        this.options.logger.error({ err }, "GTFS refresh promise rejected"),
      );
    }, intervalMs);
  }

  private async refresh(): Promise<void> {
    const { logger, gtfsUrls, minTripsPerRoute } = this.options;
    if (gtfsUrls.length === 0) {
      // PTB-only deployment: no GTFS_STATIC_URL fallback is configured, so there
      // is nothing to network-refresh. Skip quietly — the node is healthy on its
      // PTB bundle. Routing through loadViaNetwork here would throw the
      // fail-closed error every interval and error-log an otherwise-healthy node.
      logger.debug("No GTFS_STATIC_URL configured — skipping periodic network refresh (PTB-only mode)");
      return;
    }
    try {
      const result = await loadGtfs(gtfsUrls, this.etags, minTripsPerRoute ?? 0);
      if (!result) {
        logger.debug("GTFS feeds not modified");
        return;
      }
      this.validateCity(result.canonical);
      this.etags = result.etags;
      // Unlike loadOnce(), refresh() ALWAYS swaps in network-fetched
      // (loadGtfs) data — it never takes the PTB path. `ptnBundlePath` is
      // resolved once at container boot to a specific generation directory
      // (pt-startup.sh) and does not track the producer's later publishes,
      // so it has no connection to what this network fetch just returned;
      // reusing it here would color/anchor this swap's routes from a
      // disconnected, possibly-stale snapshot. `_loaderMode` staying "ptb"
      // (it's only ever set in loadOnce()) describes how the deployment
      // *booted*, not the source of *this* swap's data — passing undefined
      // degrades to the same first-class "colors absent" state gtfs-network
      // mode already uses, rather than risking silently mismatched colors.
      this.store.swap(result.indexes, result.canonical, result.routingInput, this.options.minTripsPerRoute ?? 0, undefined);
      this.store.setShapes(result.shapes ?? []);
      this._lastError = null;
      logger.info(
        {
          stopCount: result.canonical.stopCount,
          feedCount: gtfsUrls.length,
          shapeCount: result.shapes?.length ?? 0,
          droppedShapes: result.droppedShapes ?? 0,
        },
        "GTFS feed(s) refreshed",
      );
      this.schedulePublishBundle(result.canonical, result.feedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      logger.error(err, "GTFS refresh failed");
    }
  }

  stop(): void {
    // Set FIRST so the guard refuses new builds and the finally drops any
    // coalesced follow-up. A build already in flight completes its current
    // atomic swap; no coalesced build launches after stop().
    this._stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
