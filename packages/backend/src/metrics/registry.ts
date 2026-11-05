import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import type { TelemetryEvent } from "../routes/telemetry.js";
/**
 * Shared prom-client registry for the internal-metrics Fastify. A single
 * shared registry is used for the loopback `/metrics` endpoint so the route
 * handlers, telemetry route, and per-event counters all expose through one
 * scrape target.
 *
 * Production exports `metricsRegistry` (singleton). Tests that need a clean
 * slate should call `createMetricsRegistry()`.
 */
class MetricsRegistry {
  readonly registry = new Registry();
  readonly scheduleTileRequestTotal: Counter<"status">;
  readonly scheduleTile404Total: Counter<"reason">;
  readonly rtTileRequestTotal: Counter<"status" | "cache_hit">;
  readonly bundleBuildTotal: Counter<"status">;
  readonly bundleBuildCoalescedTotal: Counter<string>;
  readonly bundleLastSuccessTimestampSeconds: Gauge;
  readonly bundleEverBuilt: Gauge;
  readonly scheduleTileSource: Gauge<"source">;
  readonly raptorBundleRequests: Counter<"status" | "encoding">;
  readonly poiTileRequests: Counter<"status" | "poi_city">;
  readonly clientEngineFailureReports: Counter<"kind">;

  /**
   * C4 Stage 1 (B4/B6) — producer-artifact served vs fallback (I-3). In
   * `PT_SCHEDULE_TILE_SOURCE=producer` mode `/api/rt` groups via the
   * per-generation `trip-route.json` artifact, which sheds OPEN into
   * `canonical`, silently. The `artifact="stop_cell"` series is DEAD as of
   * 2026-08-10: its only incrementer was `/api/departures`, deleted with the
   * legacy-departures retirement. The label is retained rather than narrowed so
   * a future reader of `stop-cell.json` lights the series back up for free. `result="served"` = the artifact answered the request;
   * `result="fallback"` = the artifact was absent / unreadable / SHA-mismatched
   * OR did not know the trip/stop (a per-key miss), so the request fell through
   * to the legacy `canonical` path. The persistently-absent-artifact case
   * (ENOENT every request) MUST count `fallback` even though it stays
   * `warn`-quiet — otherwise a broken artifact is invisible after the per-city
   * flip (prod is unreachable from the dev box). Bounded: 2 artifacts × 2
   * results = 4 series. Alert: ProducerArtifactFallback.
   */
  readonly producerArtifactServedTotal: Counter<"artifact" | "result">;

  // Latency / size / availability histograms — Tier 1 server-derivable signals.
  readonly httpRequestDurationSeconds: Histogram<"method" | "route" | "status_code">;
  readonly bundleBuildDurationSeconds: Histogram<"status">;
  readonly compressedTileBytes: Histogram<string>;
  readonly metricsSidecarUp: Gauge;
  readonly scheduleTileOversizedLeaves: Gauge<"city">;
  readonly scheduleTileMaxLeafBytes: Gauge<"city">;
  readonly scheduleTileLeavesPerBundle: Gauge<"city">;
  readonly scheduleTileOversizedLeafTotal: Counter<"city">;

  // Per-event counter handles, used by `emitTelemetry`.
  readonly sanityClampTotal: Counter<string>;
  readonly bundleThrashTotal: Counter<string>;
  readonly truncatedLookaheadTotal: Counter<string>;
  readonly absurdCountdownTotal: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.scheduleTileRequestTotal = new Counter({
      name: "pt_schedule_tile_request_total",
      help: "Schedule-tile route request count by status (200, 304, 404, 409, 400, 503)",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.rtTileRequestTotal = new Counter({
      name: "pt_rt_tile_request_total",
      help: "RT-tile route request count by status and cache outcome",
      labelNames: ["status", "cache_hit"] as const,
      registers: [this.registry],
    });

    this.scheduleTile404Total = new Counter({
      name: "pt_schedule_tile_404_total",
      help: "Schedule/RT-tile 404 count by reason (subdivided, not_found)",
      labelNames: ["reason"] as const,
      registers: [this.registry],
    });

    // Bundle build observability. The build happens on `setImmediate` after
    // each `swap()`, fire-and-forget. Without these, a chronically-failing
    // build would silently serve stale tiles indefinitely while the request
    // counters stay at status="200". Alert on
    // `pt_bundle_last_success_timestamp_seconds > 0 and (time() - pt_bundle_last_success_timestamp_seconds) > 2 * refresh_interval_seconds`
    // (the `> 0` guard avoids the ~56yr never-built reading; never-built is the
    // separate `pt_bundle_ever_built == 0` signal — see the alert rules).
    this.bundleBuildTotal = new Counter({
      name: "pt_bundle_build_total",
      help: "buildAndPublishBundle outcomes by status (success, failure)",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });
    this.bundleLastSuccessTimestampSeconds = new Gauge({
      name: "pt_bundle_last_success_timestamp_seconds",
      help: "Unix timestamp (seconds) of the most recent successful bundle publish; hydrated from manifest.json on startup so the value reflects the on-disk artifact rather than this process's in-memory history.",
      registers: [this.registry],
    });

    // Honest "no bundle" signal. The last-success timestamp gauge defaults to 0
    // (prom-client constructor reset()), so `time() - gauge` reads ~56 years for
    // a backend that has NEVER built a bundle — indistinguishable from a real
    // age in a staleness panel. This 0/1 gauge disambiguates: 0 = never built
    // (this process AND no hydratable manifest), 1 = a usable bundle exists.
    // Label-free; the scrape job's static_configs stamps `city` as a target
    // label. prom default-0 already encodes the never-built case, so no
    // boot-time .set(0).
    this.bundleEverBuilt = new Gauge({
      name: "pt_bundle_ever_built",
      help: "1 once a usable schedule-tile bundle has ever been published this process or hydrated from an on-disk manifest; 0 = never built (the staleness gauge reads epoch in this state).",
      registers: [this.registry],
    });

    // Schedule-tile build ownership (PT_SCHEDULE_TILE_SOURCE). In `producer`
    // mode the producer (schedule-tile-gen.mjs, shelled out from refresh.rs)
    // builds the bundle and the backend SKIPS its in-process
    // buildAndPublishBundle — so `pt_bundle_ever_built` stays 0 forever on
    // the backend and BundleNeverBuilt would page ~10m after every producer
    // restart. This 1-valued, single-`source`-label gauge lets the alert
    // suppress that case (`unless on(city) pt_schedule_tile_source{source="producer"}`
    // — see the alert rules). Set once at process start from the env;
    // the value never changes for a given process. Label-free except for the
    // mode discriminator; the scrape job stamps `city`/`job` as target labels.
    this.scheduleTileSource = new Gauge({
      name: "pt_schedule_tile_source",
      help: "Schedule-tile build ownership for this backend process: 1 with source=\"producer\" when the producer builds tiles (backend skips its in-process build, so pt_bundle_ever_built stays 0 by design) and source=\"backend\" otherwise. Set once at startup from PT_SCHEDULE_TILE_SOURCE.",
      labelNames: ["source"] as const,
      registers: [this.registry],
    });
    this.scheduleTileSource.set(
      { source: process.env.PT_SCHEDULE_TILE_SOURCE === "producer" ? "producer" : "backend" },
      1,
    );

    // Incremented when a build trigger arrives while a build is already in
    // flight and is coalesced into the single pending slot — the one new runtime
    // behaviour of the async build; a rising rate = refresh pressure outrunning
    // build throughput. Label-free (one city per process).
    this.bundleBuildCoalescedTotal = new Counter({
      name: "pt_bundle_build_coalesced_total",
      help: "Bundle-build triggers coalesced because a build was already in flight (async build re-entrancy guard).",
      registers: [this.registry],
    });

    // GET /api/<city>/raptor-bundle observability. Labels: `status` (200/304/503) and `encoding`
    // (gzip/identity/none). Lets ops see the gzip hit-rate (panel devops M3) and the unavailable
    // rate when PT_BUNDLE_PATH is unset or the file is missing/empty.
    this.raptorBundleRequests = new Counter({
      name: "pt_raptor_bundle_requests_total",
      help: "GET /api/<city>/raptor-bundle response count by status + encoding",
      labelNames: ["status", "encoding"] as const,
      registers: [this.registry],
    });

    this.clientEngineFailureReports = new Counter({
      name: "pt_client_engine_failure_reports_total",
      help: "Opt-in client engine-failure reports by kind",
      labelNames: ["kind"] as const,
      registers: [this.registry],
    });

    // POI tile route observability. `poi_city` is either one of the at-most-four manifest-backed
    // cities or "unknown", so cardinality is bounded even when callers probe arbitrary city ids.
    this.poiTileRequests = new Counter({
      name: "pt_poi_tile_requests_total",
      help: "GET /api/gtfs/poi-tile/* response count by POI city and status",
      labelNames: ["status", "poi_city"] as const,
      registers: [this.registry],
    });

    // C4 Stage 1 producer-artifact served/fallback (I-3, I-2). See the field doc.
    // 4-series cap (artifact ∈ {trip_route, stop_cell} × result ∈ {served,
    // fallback}).
    //
    // `result="fallback"` means "the artifact DID NOT ANSWER this lookup" — it CONFLATES two very
    // different causes: (a) a benign per-key/per-stop miss (a trip absent from the frozen
    // generation, B-5 refresh skew; a stop with no built tile) — the artifact is healthy, it just
    // doesn't know that one key, and (b) a wholly-broken artifact (absent / unreadable /
    // SHA-mismatched) that answers NOTHING — every lookup falls through. So a nonzero `fallback`
    // rate is NOT by itself a broken-artifact signal (it flaps with benign skew). The PRIMARY
    // broken-artifact signal is the /health/ready presence field `tripRouteArtifactPresent` /
    // `stopCellArtifactPresent` being `false` (the loader couldn't load the map at all). This
    // counter is a SECONDARY signal whose rate threshold needs a per-city steady-floor soak-capture
    // before it can be trusted (a healthy feed has a nonzero benign floor).
    this.producerArtifactServedTotal = new Counter({
      name: "pt_producer_artifact_served_total",
      help: "Producer-mode read-plane lookups by artifact and result. result=served: the per-generation artifact (trip-route.json/stop-cell.json) answered. result=fallback: the artifact did not answer (a benign per-key/per-stop skip OR a wholly-broken artifact that fell through to canonical) — NOT a standalone broken-artifact signal; see tripRouteArtifactPresent on /health/ready.",
      labelNames: ["artifact", "result"] as const,
      registers: [this.registry],
    });

    // HTTP latency histogram. Single addition gives p50/p95/p99 per route AND
    // per-route error rate via the status_code label. `route` is the matched
    // Fastify route template (e.g. `/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords`),
    // NOT the raw URL — cardinality is bounded by the registered route set.
    // Default prom-client buckets are calibrated for HTTP.
    this.httpRequestDurationSeconds = new Histogram({
      name: "pt_http_request_duration_seconds",
      help: "HTTP request handling time in seconds, by method, route template, and status code",
      labelNames: ["method", "route", "status_code"] as const,
      registers: [this.registry],
    });

    // Bundle build duration. Recorded for both success and failure arms — a
    // failing build that's getting slower (e.g. brotli pressure approaching
    // the cell-size cap on a large feed) is the early warning for the
    // off-main-thread work tracked in the tiled-stop-schedules backlog.
    this.bundleBuildDurationSeconds = new Histogram({
      name: "pt_bundle_build_duration_seconds",
      help: "buildAndPublishBundle wall time in seconds, by outcome status",
      labelNames: ["status"] as const,
      // Buckets cover small-feed (~1s) to largest-known-feed (~30 min).
      buckets: [1, 5, 15, 60, 180, 600, 1800],
      registers: [this.registry],
    });

    // Compressed tile size — observed once per compress attempt, INCLUDING
    // over-cap cells that throw (see scheduleTileBrotli.ts: observation
    // happens before the throw on purpose, so p99 reflects build pressure
    // rather than silently dropping the worst offenders). No labels: each
    // backend serves one city, so the `job` Prometheus label already
    // segments per-city.
    this.compressedTileBytes = new Histogram({
      name: "pt_compressed_tile_bytes",
      help: "Per-cell compressed (brotli) schedule-tile size in bytes, observed on every compress attempt (including over-cap cells that throw)",
      // Top bucket is past `MAX_COMPRESSED_TILE_BYTES` so over-cap throws
      // are still captured before the encoder rejects the cell.
      buckets: [10_240, 51_200, 102_400, 256_000, 512_000, 1_024_000, 1_500_000, 2_000_000, 2_500_000],
      registers: [this.registry],
    });

    // Schedule-tile subdivision degradation signals (Part 2b). When best-effort
    // subdivision keeps an over-cap city building, these are the "are we
    // degraded NOW" gauges (the build counters go quiet once it succeeds). Set
    // by the scheduler from the build stats on every successful publish. The
    // `city` label is set explicitly (one backend per city) so the alert can
    // template `{{ $labels.city }}`.
    this.scheduleTileOversizedLeaves = new Gauge({
      name: "pt_schedule_tile_oversized_leaves",
      help: "Current count of over-cap (irreducible) schedule-tile leaves in the live bundle; 0 when clean. Set on every successful publish.",
      labelNames: ["city"] as const,
      registers: [this.registry],
    });
    this.scheduleTileMaxLeafBytes = new Gauge({
      name: "pt_schedule_tile_max_leaf_bytes",
      help: "Largest live schedule-tile leaf size in compressed bytes (trend/alarm).",
      labelNames: ["city"] as const,
      registers: [this.registry],
    });
    this.scheduleTileLeavesPerBundle = new Gauge({
      name: "pt_schedule_tile_leaves_per_bundle",
      help: "Total schedule-tile files (cells + subdivision leaves) written in the live bundle.",
      labelNames: ["city"] as const,
      registers: [this.registry],
    });
    // Cumulative ("how often ever") companion to the oversized-leaves GAUGE. A monotonic counter
    // cannot represent a current level (finding E2), so the gauge above is what the alert pages on;
    // this counter answers "how many oversized leaves have we ever produced" for trend/post-mortem.
    // `.inc`'d in the scheduler success arm only when oversized > 0.
    this.scheduleTileOversizedLeafTotal = new Counter({
      name: "pt_schedule_tile_oversized_leaf_total",
      help: "Cumulative count of over-cap (irreducible) schedule-tile leaves produced across all publishes.",
      labelNames: ["city"] as const,
      registers: [this.registry],
    });

    // Sidecar liveness. One-shot: set to 1 in `startMetricsServer` after
    // `app.listen()` resolves; never reset. Distinguishes "main app crashed"
    // (no scrape lands at all) from "main app fine, scrape config pointed at
    // the wrong port" (scrape lands but `pt_metrics_sidecar_up` is absent
    // because the legitimate sidecar never bound here). Not a full liveness
    // signal — Prometheus's synthetic `up{}` already covers the running case.
    this.metricsSidecarUp = new Gauge({
      name: "pt_metrics_sidecar_up",
      help: "1 once startMetricsServer's listen() resolved during this process. One-shot at-boot signal; not a continuous liveness indicator (use Prometheus's up{} for that).",
      registers: [this.registry],
    });

    this.sanityClampTotal = new Counter({
      name: "pt_sanity_clamp_total",
      help: "Client-side sanity-clamp triggers (countdown clamped to absolute ceiling)",
      registers: [this.registry],
    });
    this.bundleThrashTotal = new Counter({
      name: "pt_bundle_thrash_total",
      help: "409-cascade hit the 3-strike ceiling (bundle hash flipped 3+ times rapidly)",
      registers: [this.registry],
    });
    this.truncatedLookaheadTotal = new Counter({
      name: "pt_truncated_lookahead_total",
      help: "Client requested a lookahead that exceeded the supported window and was truncated",
      registers: [this.registry],
    });
    this.absurdCountdownTotal = new Counter({
      name: "pt_absurd_countdown_total",
      help: "User saw a countdown above the absurdity threshold",
      registers: [this.registry],
    });
  }

  /** Dispatch a validated `POST /api/telemetry` event to the matching named counter. */
  emitTelemetry(event: TelemetryEvent): void {
    const inc = event.value ?? 1;
    switch (event.event) {
      case "sanity_clamp": this.sanityClampTotal.inc(inc); break;
      case "bundle_thrash": this.bundleThrashTotal.inc(inc); break;
      case "truncated_lookahead": this.truncatedLookaheadTotal.inc(inc); break;
      case "absurd_countdown": this.absurdCountdownTotal.inc(inc); break;
      // Unreachable at runtime: the HTTP route validates against the same
      // allowlist (`routes/telemetry.ts ALLOWED_EVENTS`). The compile-time
      // `never` check will fail to typecheck if a future name is added to
      // `TelemetryEventName` without a matching switch arm.
      default: {
        const _exhaustive: never = event.event;
        return _exhaustive;
      }
    }
  }

}

export type { MetricsRegistry };

/**
 * Factory for a fresh registry. Production uses the shared `metricsRegistry`
 * singleton; tests that need to assert counter values without cross-test
 * leakage should call this directly.
 */
export function createMetricsRegistry(): MetricsRegistry {
  return new MetricsRegistry();
}

export const metricsRegistry = createMetricsRegistry();
