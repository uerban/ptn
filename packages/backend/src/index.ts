import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { readFileSync } from "node:fs";
import { planRoute } from "./routes/plan.js";
import { getNearby } from "./routes/nearby.js";
import { searchStops } from "./routes/search.js";
import { getAlerts } from "./routes/alerts.js";
import { getHealth, registerHealthProbes } from "./routes/health.js";
import { createAdapterRegistry } from "./adapters/registry.js";
import { GtfsScheduler } from "./gtfs/scheduler.js";
import { createProducerScheduleTileSource } from "./gtfs/producerScheduleTiles.js";
import {
  createProducerArtifacts,
  type ProducerArtifacts,
  type ProducerArtifactsDeps,
  type ProducerArtifactShas,
  type ResolvedGeneration,
} from "./gtfs/producerArtifacts.js";
import { createProducerRouteRt } from "./gtfs/producerRouteRt.js";
import { GtfsRealtimePoller } from "./gtfs/realtime.js";
import { resolveGtfsStaticUrls } from "./gtfs/resolveGtfsStaticUrls.js";
import { getStopsNearby, getStopsAll } from "./routes/stops.js";
import { getRouteRt, createGetRouteRtHandler } from "./routes/rt.js";
import { getStopRoutesFilter } from "./routes/debug.js";
import { registerRoutingBundleRoutes } from "./routes/routingBundle.js";
import { registerShapesRoute } from "./routes/shapes.js";
import { registerTransfersRoute } from "./routes/transfers.js";
import { registerRaptorBundleRoute } from "./routes/raptorBundle.js";
import { TransfersStore } from "./gtfs/transfersStore.js";
import { createColorConfigHandler } from "./routes/colorConfig.js";
import { registerRtHealthRoute } from "./routes/rtHealth.js";
import { resolveMetricsHost, startMetricsServer } from "./routes/metrics.js";
import { metricsRegistry } from "./metrics/registry.js";
import { installHttpDurationHook } from "./metrics/httpDurationHook.js";
import { getVersion } from "./routes/version.js";
import { buildInfo } from "./generated/buildInfo.js";
import { registerRateLimit, rateLimitForRoute } from "./plugins/rateLimit.js";
import { registerCityGuard } from "./plugins/cityGuard.js";
import { installProductionHttpHook } from "./plugins/productionHttp.js";
import {
  createPoiTileHandler,
  createBundleFileLoader,
} from "./routes/poiTile.js";
import { createScheduleTileHandler } from "./routes/scheduleTile.js";
import { createRtTileHandler } from "./routes/rtTile.js";
import { createGtfsManifestHandler } from "./routes/gtfsManifest.js";
import { createTelemetryHandler } from "./routes/telemetry.js";
import { createClientReportHandler } from "./routes/clientReport.js";
import { getCityProfile } from "./harness/cities/index.js";
import {
  RT_BACKEND_POLL_INTERVAL_MS,
  type CityProfile,
  type SelfHostedGeocoderConfig,
} from "@pt/shared";
import { fileURLToPath } from "node:url";

/** 64 lowercase hex chars — the shape of a content-addressed generationId. */
const GENERATION_ID_RE = /^[0-9a-f]{64}$/;

/** Minimal `current.json` pointer shape (`PointerManifest`). */
interface CurrentPointer {
  generationId?: unknown;
}

/** The two SHA fields the producer records in `generation.json` (C4 B4/B6). */
interface GenerationManifestShas {
  tripRouteSha256?: unknown;
  stopCellSha256?: unknown;
}

/**
 * Derive the single `createProducerArtifacts` resolver dep (`readGeneration`)
 * from `PT_DATA_ROOT`, mirroring `ProducerScheduleTileSource`'s `current.json`
 * resolution but pointed at the generation ROOT (`<dataRoot>/generations/<gen>/`)
 * where the C4 producer artifacts live (`tileSource.resolveDataDir()` returns the
 * `schedule-tiles` CHILD of that dir, so it can't be reused verbatim).
 *
 * I-1: `generationId`, the gen dir, and the expected SHAs all come from ONE
 * `current.json` read (+ one `generation.json` read) per call — closing both the
 * three redundant `current.json` reads the old three-thunk shape incurred per
 * resolution AND the cross-seam tear (three independent reads could straddle a
 * mid-publish `current.json` rewrite, mixing one generation's id with another's
 * dir/SHAs). A generation roll re-points cleanly (the loader caches the parsed
 * maps keyed on the returned `generationId`, so the per-call read is the cheap
 * couple-hundred-byte pointer + the small generation manifest, never the artifact
 * bodies). Returns `null`/no-throw on any cold-start / mid-publish / malformed
 * state — the loader treats that as artifact-absent and the consumers fall
 * through to the canonical path.
 */
export function producerArtifactsResolvers(
  dataRoot: string | undefined,
  log?: ProducerArtifactsDeps["log"],
): Pick<ProducerArtifactsDeps, "readGeneration"> {
  function readGeneration(): ResolvedGeneration | null {
    if (!dataRoot) return null;
    // (1) ONE current.json read → generationId + gen dir.
    let pointer: CurrentPointer;
    try {
      pointer = JSON.parse(
        readFileSync(path.join(dataRoot, "current.json"), "utf8"),
      ) as CurrentPointer;
    } catch {
      // Absent (cold start) / malformed (mid-publish race) ⇒ no generation.
      return null;
    }
    const generationId = pointer.generationId;
    if (typeof generationId !== "string" || !GENERATION_ID_RE.test(generationId)) {
      return null;
    }
    const dir = path.join(dataRoot, "generations", generationId);

    // (2) ONE generation.json read → expected SHAs (same generation snapshot as
    // the id/dir above — no separate re-read of current.json).
    let manifest: GenerationManifestShas;
    try {
      manifest = JSON.parse(
        readFileSync(path.join(dir, "generation.json"), "utf8"),
      ) as GenerationManifestShas;
    } catch (err) {
      // generation.json should exist whenever current.json points at the dir;
      // a non-ENOENT read failure is abnormal (torn write / TOCTOU reap).
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log?.warn?.({ err, dir }, "producer artifacts: generation.json unreadable");
      }
      // Still a resolved generation (id + dir), just no SHAs ⇒ artifacts absent.
      return { generationId, dir, shas: {} };
    }

    const shas: ProducerArtifactShas = {
      tripRoute:
        typeof manifest.tripRouteSha256 === "string" ? manifest.tripRouteSha256 : undefined,
      stopCell:
        typeof manifest.stopCellSha256 === "string" ? manifest.stopCellSha256 : undefined,
    };
    return { generationId, dir, shas };
  }

  return { readGeneration };
}

/**
 * Construct the per-generation producer-artifact loader (C4 Stage 1), or `null` outside
 * producer mode.

 *
 * Returns `null` unless `env.PT_SCHEDULE_TILE_SOURCE === "producer"` — backend
 * mode (the default) attempts no artifact load, so its one remaining consumer
 * (`/api/rt/:routeId`) reads `canonical` byte-unchanged. In
 * producer mode it derives the three loader resolvers from `env.PT_DATA_ROOT`
 * (`producerArtifactsResolvers`) and hands them to `createProducerArtifacts`.
 *
 * The construction is split out of `main()` so it is unit-testable without
 * booting the server (mirroring `setBuildInfoHeaders`). `deps.createArtifacts`
 * is injectable for tests; production omits it and uses the real factory.
 */
export function buildProducerArtifacts(
  env: { PT_SCHEDULE_TILE_SOURCE?: string; PT_DATA_ROOT?: string },
  deps?: {
    createArtifacts?: (d: ProducerArtifactsDeps) => ProducerArtifacts;
    log?: ProducerArtifactsDeps["log"];
  },
): ProducerArtifacts | null {
  if ((env.PT_SCHEDULE_TILE_SOURCE ?? "backend") !== "producer") return null;
  const create = deps?.createArtifacts ?? createProducerArtifacts;
  const resolvers = producerArtifactsResolvers(env.PT_DATA_ROOT, deps?.log);
  return create({ ...resolvers, log: deps?.log });
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// Phase B sidecar opt-in: when set and the path exists, the scheduler reads
// the Rust producer's PTB + JSON sidecars instead of downloading GTFS zips.
// Unset (the default) preserves the existing Node-only path for dev mode.
const PT_BUNDLE_PATH = process.env.PT_BUNDLE_PATH;
// In PTB mode an empty GTFS_STATIC_URL must NOT fall back to the vilnius
// default — see resolveGtfsStaticUrls + the scheduler's fail-closed guard.
const GTFS_STATIC_URLS = resolveGtfsStaticUrls(process.env.GTFS_STATIC_URL, Boolean(PT_BUNDLE_PATH));
const GTFS_RT_TRIP_UPDATES_URLS: string[] = (
  process.env.GTFS_RT_TRIP_UPDATES_URL ??
  "https://www.stops.lt/vilnius/trip_updates.pb"
)
  .split(",")
  .map((u) => u.trim())
  .filter((u) => u.length > 0);
const GTFS_REFRESH_INTERVAL_HOURS = parseInt(
  process.env.GTFS_REFRESH_INTERVAL_HOURS ?? "6",
  10,
);
const STOP_ROUTES_MIN_TRIPS = parseInt(
  process.env.STOP_ROUTES_MIN_TRIPS ?? "0",
  10,
);
const CITY_ID = process.env.CITY_ID ?? "vilnius";
// Root dir for tiled-stop-schedule bundles. Each bundle lives at
// `<SCHEDULE_TILE_DATA_DIR>/<bundleHash>/` and the manifest at
// `<SCHEDULE_TILE_DATA_DIR>/manifest.json`. Defaults to `<cwd>/data/tiles`.
const SCHEDULE_TILE_DATA_DIR =
  process.env.SCHEDULE_TILE_DATA_DIR ?? path.join(process.cwd(), "data", "tiles");
// Schedule-tile serving source (interim producer-build spike-killer). "backend" (default): serve +
// advertise the backend's in-process build output from SCHEDULE_TILE_DATA_DIR — byte-for-byte
// unchanged behavior. "producer": serve + advertise the bundle the PRODUCER already built into the
// current published generation dir (`<genDir>/schedule-tiles/...`), resolved live from
// `<PT_DATA_ROOT>/current.json` so a generation roll re-advertises the new hash. The in-process
// build is unaffected (disables it separately).
const SCHEDULE_TILE_SOURCE = process.env.PT_SCHEDULE_TILE_SOURCE ?? "backend";
if (SCHEDULE_TILE_SOURCE !== "backend" && SCHEDULE_TILE_SOURCE !== "producer") {
  throw new Error(
    `PT_SCHEDULE_TILE_SOURCE="${SCHEDULE_TILE_SOURCE}" is not a recognised value. ` +
      `Expected "backend" (default) or "producer".`,
  );
}
// Producer mode resolves the schedule-tile gen dir from PT_DATA_ROOT/current.json
// per request. Without PT_DATA_ROOT the source silently resolves an undefined
// dataRoot → every tile request 409s with no signal. Fail loudly at startup.
if (SCHEDULE_TILE_SOURCE === "producer" && !process.env.PT_DATA_ROOT) {
  throw new Error(
    `PT_SCHEDULE_TILE_SOURCE=producer requires PT_DATA_ROOT (the published ` +
      `generation root with current.json) — it is unset or empty.`,
  );
}
// Root dir for pre-computed transfers artifacts. Each city/variant lives at
// `<TRANSFERS_DATA_DIR>/transfers/<cityId>/<variant>/transfers.bin`. Defaults
// to `<cwd>/data` so the layout matches `scripts/build-transfers.mjs`.
const TRANSFERS_DATA_DIR =
  process.env.TRANSFERS_DATA_DIR ?? path.join(process.cwd(), "data");
const TRANSFERS_VARIANT = process.env.TRANSFERS_VARIANT ?? "pedestrian-only";

interface ApiCityGeocoderEnv {
  GEOCODER_FLAVOR?: string;
  GEOCODER_MULTI_TENANT?: string;
}

export function resolveApiCityGeocoder(
  profile: Pick<CityProfile, "id">,
  env: ApiCityGeocoderEnv = process.env,
): SelfHostedGeocoderConfig | undefined {
  const geocoderFlavor = env.GEOCODER_FLAVOR;
  const multiTenant = env.GEOCODER_MULTI_TENANT !== "false";
  if (geocoderFlavor === "ptn-fst") {
    return {
      kind: "self-hosted",
      endpoint: `/api/${profile.id}/address-search`,
      flavor: geocoderFlavor,
      multiTenant,
    };
  }
  if (geocoderFlavor === "nominatim" || geocoderFlavor === "photon") {
    return {
      kind: "self-hosted",
      endpoint: `/geocoder/${geocoderFlavor}`,
      flavor: geocoderFlavor,
      multiTenant,
    };
  }
  return undefined;
}

async function main() {
  const app = Fastify({ logger: true });

  // Install BEFORE cors/rate-limit/city-guard so rejected traffic
  // (CORS preflights, 429s, 403 city-guard) lands in the histogram with the
  // correct status_code. If installed after, those plugins' `onRequest`
  // short-circuit ours and the rejected traffic disappears silently.
  installHttpDurationHook(app);

  await app.register(cors, { origin: true });
  await registerRateLimit(app);
  await registerCityGuard(app, { cityId: CITY_ID });

  installProductionHttpHook(app, buildInfo);

  // Initialize GTFS scheduler (store starts empty until feed loads)
  const scheduler = new GtfsScheduler({
    gtfsUrls: GTFS_STATIC_URLS,
    refreshIntervalHours: GTFS_REFRESH_INTERVAL_HOURS,
    logger: app.log,
    minTripsPerRoute: STOP_ROUTES_MIN_TRIPS,
    cityId: CITY_ID,
    scheduleTileDataDir: SCHEDULE_TILE_DATA_DIR,
    rtFeedUrls: GTFS_RT_TRIP_UPDATES_URLS,
    ptnBundlePath: PT_BUNDLE_PATH,
  });

  app.decorate("gtfsStore", scheduler.getStore());
  app.decorate("gtfsScheduler", scheduler);

  // Producer-build source (interim spike-killer). In `producer` mode the
  // schedule-tile / rt-tile / manifest routes read from the
  // current published generation dir instead of the backend's in-process build
  // output. The source re-resolves the gen dir from `current.json` per request,
  // so a generation roll (pt-serve self-reload / producer republish)
  // re-advertises the new hash — the boot-time resolution is NOT frozen. `null`
  // in `backend` mode.
  const producerTileSource =
    SCHEDULE_TILE_SOURCE === "producer"
      ? createProducerScheduleTileSource(process.env.PT_DATA_ROOT, { log: app.log })
      : null;
  if (producerTileSource) {
    app.log.info(
      { dataRoot: process.env.PT_DATA_ROOT ?? null },
      "schedule-tile source = producer: serving + advertising the producer-built gen-dir bundle",
    );
  }
  // Per-generation producer-artifact loader (C4 Stage 1). In `producer` mode it
  // reads the two per-generation artifacts the producer build emits into the gen
  // dir ROOT (`trip-route.json` + `stop-cell.json`), SHA-verified against
  // `generation.json`, cached on `generationId`. `null` in `backend` mode (the
  // default) ⇒ no artifact load attempted, both consumers read `canonical`
  // byte-unchanged. This is the C4-survivable seam: it holds NO `GtfsStore`/
  // `canonical` reference (see gtfs/producerArtifacts.ts).
  const producerArtifacts = buildProducerArtifacts(process.env, { log: app.log });
  if (producerArtifacts) {
    app.log.info(
      { dataRoot: process.env.PT_DATA_ROOT ?? null },
      "producer-artifact loader active: /api/rt reads trip-route.json (no canonical)",
    );
  }

  // The producer-mode departures source used to be wired here, feeding
  // `/api/departures`. That route is gone (see the retirement plan), so this is
  // now the ONLY thing that read `producerArtifacts.tileCoordsForStop`, and with
  // it gone `stop-cell.json` has NO production reader left on either plane —
  // pt-serve does not read it either.
  //
  // The artifact is still EMITTED by the producer build and still reported by
  // `/health/ready` (`artifactsPresent().stopCell`, `loadedShas().stopCell`).
  // `gtfs/producerDepartures.ts` is deliberately kept rather than deleted with
  // the route: its differential test is the only check that `stop-cell.json`
  // maps stops to the tiles they actually live in, and dropping that would leave
  // a shipped artifact unverified. Either give it a reader again or stop
  // emitting it — a decision that touches the producer and `/health/ready`'s
  // response shape, so not this PR.

  // B4: producer-mode `/api/rt/:routeId` grouping source. Groups the store's
  // index-free RT enumeration (`getRealtimeTripUpdates`) by route via the
  // `trip-route.json` artifact (`routeForTrip`) — NO `canonical.getTrip` read. A
  // trip absent from the frozen generation is SKIPPED (B-5), not
  // canonical-fallen-through. `null` in `backend` mode ⇒ the rt handler reads
  // `store.getRealtimeForRoute` (canonical) byte-unchanged.
  //
  // B1: a WHOLLY-ABSENT `trip-route.json` (unreadable / SHA-mismatched / never
  // emitted) would otherwise resolve every trip to `undefined` and serve empty
  // RT for every route — a city-wide blackout. When `artifactsPresent().tripRoute`
  // is false the source falls through to `store.getRealtimeForRoute` (canonical)
  // and counts a single `fallback`. The per-key B-5 skip is unchanged.
  const producerRouteRt = producerArtifacts
    ? createProducerRouteRt({
        getRealtimeTripUpdates: () => scheduler.getStore().getRealtimeTripUpdates(),
        // B2: resolve the trip→route lookup once per request (one current.json
        // read), then group in memory — no per-trip readFileSync.
        resolveRouteForTrip: () => producerArtifacts.routeLookup(),
        artifactPresent: () => producerArtifacts.artifactsPresent().tripRoute,
        canonicalFallback: (routeId) => scheduler.getStore().getRealtimeForRoute(routeId),
        // I-3: count per-trip artifact resolution. An unknown trip (B-5 skip)
        // counts `fallback`; a resolved trip `served`. A wholly-absent artifact
        // counts a single `fallback` per request (the canonical path answered).
        onArtifactResult: (result) =>
          metricsRegistry.producerArtifactServedTotal.inc({ artifact: "trip_route", result }),
      })
    : null;

  // Attach the pre-computed transfers artifact (when present on disk) to
  // the store so the /api/transfers/fetch route and PTB response metadata can
  // serve the same current bytes. Independent of GTFS refreshes — the artifact
  // is rebuilt out-of-band and re-read on mtime change.
  const transfersStore = new TransfersStore(
    CITY_ID,
    TRANSFERS_VARIANT,
    TRANSFERS_DATA_DIR,
  );
  scheduler.getStore().setTransfersStore(transfersStore);

  // Bias remote stop search toward the city this process serves. Without it a
  // generic stop name resolves wherever upstream ranks it — which for a name
  // that repeats across the country is usually another city entirely.
  const adapters = createAdapterRegistry(getCityProfile(CITY_ID)?.bbox);
  app.decorate("adapters", adapters);

  // Shutdown wiring for the metrics sidecar started after `app.listen` below.
  // The hook MUST be registered here, before listen — Fastify throws
  // FST_ERR_INSTANCE_ALREADY_LISTENING on addHook once the server is
  // listening. The slot is assigned when startMetricsServer succeeds; if the
  // sidecar never starts (bind failure) the hook is a no-op.
  let metricsApp: FastifyInstance | null = null;
  app.addHook("onClose", async () => {
    if (metricsApp) await metricsApp.close();
  });

  app.get("/api/plan", { config: { rateLimit: rateLimitForRoute("plan") } }, planRoute);
  app.get("/api/nearby", { config: { rateLimit: rateLimitForRoute("stopsBbox") } }, getNearby);
  app.get(
    "/api/stops/search",
    { config: { rateLimit: rateLimitForRoute("stopsBbox") } },
    searchStops,
  );
  app.get(
    "/api/stops/nearby",
    { config: { rateLimit: rateLimitForRoute("stopsBbox") } },
    getStopsNearby,
  );
  app.get(
    "/api/stops/all",
    { config: { rateLimit: rateLimitForRoute("stopsBbox") } },
    getStopsAll,
  );
  const poiTileStatus = {
    configured: true,
    ready: false,
    error: null as string | null,
  };
  const POI_BUNDLE_DIR =
    process.env.POI_BUNDLE_DIR ??
    path.join(process.cwd(), "..", "frontend", "public", "poi");
  const poiTileRoute = createPoiTileHandler({
    ...createBundleFileLoader({
      bundleDir: POI_BUNDLE_DIR,
      ...(process.env.POI_BUNDLE_MAX_DECODED_BYTES !== undefined ? {maxDecodedBytes: Number(process.env.POI_BUNDLE_MAX_DECODED_BYTES)} : {}),
      ...(process.env.POI_CITY_ENTRIES_CACHE_MAX_BYTES !== undefined ? {entriesCacheMaxBytes: Number(process.env.POI_CITY_ENTRIES_CACHE_MAX_BYTES)} : {}),
    }),
    onRequest: (status, poiCity) =>
      metricsRegistry.poiTileRequests.labels(String(status), poiCity).inc(),
  });
  app.get("/api/alerts", getAlerts);
  app.get("/api/health", getHealth);
  app.get("/api/version", getVersion);
  registerHealthProbes(app, {
    producerArtifacts: producerArtifacts ?? undefined,
    poiTileStatus: () => ({ ...poiTileStatus }),
  });
  app.get("/api/health/live", async (_request, reply) => {
    if (scheduler.getStore().isReady()) {
      return reply.send({ status: "ok" });
    }
    const detail: Record<string, unknown> = {
      status: scheduler.lastError ? "error" : "loading",
      cityId: CITY_ID,
    };
    if (scheduler.lastError) {
      detail.error = scheduler.lastError;
      detail.attempts = scheduler.initAttempts;
    }
    return reply.status(503).send(detail);
  });
  app.get(
    "/api/rt/:routeId",
    { config: { rateLimit: rateLimitForRoute("routeById") } },
    // Producer mode: group RT by route via the `trip-route.json` artifact (no
    // `canonical.getTrip` read). `backend` mode keeps the default handler
    // (`store.getRealtimeForRoute`, canonical) byte-for-byte unchanged.
    producerRouteRt ? createGetRouteRtHandler({ producerRouteRt }) : getRouteRt,
  );
  app.get("/api/color-config", createColorConfigHandler(scheduler.getStore()));

  registerRoutingBundleRoutes(app);
  await registerShapesRoute(app);
  registerTransfersRoute(app);

  // raw PTB bytes for pt-wasm's PtRouter::new(). The route reads PT_BUNDLE_PATH at request-time so
  // it tracks the same env var the GTFS sidecar consumes. Rate-limited under the same
  // routing-bundle family as the other multi-MB byte-serving routes; observability via onRequest →
  // the pt_raptor_bundle_requests_total counter (labels: status, encoding).
  const raptorBundleRoute = registerRaptorBundleRoute(app, {
    rateLimit: rateLimitForRoute("raptorBundle"),
    onRequest: (status, encoding) => {
      metricsRegistry.raptorBundleRequests.inc({
        status: String(status),
        encoding: encoding ?? "none",
      });
    },
    getTransfersArtifactMeta: () =>
      scheduler.getStore().getTransfersStore()?.getArtifactMeta() ?? null,
  });
  // Fire-and-forget warmup: pay the sha256 + gzip cost off the user
  // request path so the first wasm-frontend client doesn't eat the cold
  // miss (~100-500ms for a 5 MB PTB). Best-effort; failure is silent and
  // the per-request handler will surface the same error on the first hit.
  //
  // Gated on `PT_RAPTOR_BUNDLE_PREWARM=1`, and intentionally LEFT OFF in
  // pt-serve-fronted prod. Production serves GET /api/<city>/raptor-bundle
  // from pt-serve (nginx → pt-serve-<city>:9000), NOT this Node route, so
  // prewarming the Node closure cache (~10 MB: raw + gzipped PTB + sha256)
  // warms bytes prod clients never fetch — pure steady-state RAM for an
  // unused path. The wasm-default flip's memory effect therefore lands on
  // pt-serve's lazily-built raptor-bundle gzip cache (gated by
  // the pt-serve budget file), NOT Node's the Node memory budget file,
  // which the flip leaves unchanged (the frontend still fetches the routing
  // bundle for the TS index exactly as today). Enable this ONLY for
  // Node-fronted deployments (dev / single-tenant) that actually serve
  // raptor-bundle from Node; do NOT set `PT_RAPTOR_BUNDLE_PREWARM=1` in the
  // pt-serve-fronted compose/deploy files. See
  // the p6 transfers attach review deferred notes.
  const bundlePath = process.env.PT_BUNDLE_PATH;
  if (bundlePath && process.env.PT_RAPTOR_BUNDLE_PREWARM === "1") {
    void raptorBundleRoute.prewarm(bundlePath);
  }

  app.get(
    "/api/gtfs/poi-tile/:cityId/:tileSize/:tileCoords",
    poiTileRoute,
  );
  // `producerTileSource` is created earlier (right after the gtfsStore decorate);
  // the schedule-tile / rt-tile / manifest routes below reuse the SAME instance.
  // It used to be created that early so the legacy `/api/departures` shim could
  // read producer tiles too; that shim is gone, but the single-instance sharing
  // below is the reason it still lives there.
  app.get(
    "/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords",
    { config: { rateLimit: rateLimitForRoute("scheduleTile") } },
    createScheduleTileHandler(
      producerTileSource
        ? {
            // Thunk: re-resolve `<genDir>/schedule-tiles` per request. Falls
            // back to the backend dir only when the producer source can't
            // resolve (cold start / mid-publish) so a request still gets the
            // route's normal 409 `bundle_unavailable`, not a crash.
            dataDir: () => producerTileSource.resolveDataDir() ?? scheduler.getBundleDataDir(),
            getCurrentBundleHash: () => producerTileSource.getCurrentBundleHash(),
            getManifestSnapshot: () => producerTileSource.getManifestSnapshot(),
          }
        : {
            dataDir: scheduler.getBundleDataDir(),
            getCurrentBundleHash: () => scheduler.getCurrentBundleHash(),
            getManifestSnapshot: () => scheduler.getManifestSnapshot(),
          },
    ),
  );
  app.get(
    "/api/gtfs/rt-tile/:bundleHash/:tileSize/:tileCoords",
    { config: { rateLimit: rateLimitForRoute("rtTile") } },
    createRtTileHandler({
      // RT *data* (delays/cancellations) is always merged Node-side from the live RT feed
      // (getRtEntriesForTrip). Only the tile-membership SOURCE + the 409 hash-match repoint to the
      // producer in producer mode: the membership tile lives in the published generation dir (the
      // backend's in-process build is disabled there), and the manifest hash the client carries is
      // the PRODUCER hash, so matching against the backend scheduler's now-stale hash would
      // 409-mismatch forever (ST3).
      ...(producerTileSource
        ? {
            // Thunk: re-resolve `<genDir>/schedule-tiles` per request (the gen
            // dir rolls). Fall back to the backend dir only when the producer
            // source can't resolve (cold start / mid-publish) so a request gets
            // the route's normal 409 `bundle_unavailable`, not a crash.
            dataDir: () => producerTileSource.resolveDataDir() ?? scheduler.getBundleDataDir(),
            getCurrentBundleHash: () => producerTileSource.getCurrentBundleHash(),
            getManifestSnapshot: () => producerTileSource.getManifestSnapshot(),
          }
        : {
            dataDir: scheduler.getBundleDataDir(),
            getCurrentBundleHash: () => scheduler.getCurrentBundleHash(),
            getManifestSnapshot: () => scheduler.getManifestSnapshot(),
          }),
      cityId: scheduler.getCityId(),
      getRtEntriesForTrip: (tripId) => scheduler.getStore().rtEntriesForTrip(tripId),
    }),
  );
  app.get(
    "/api/gtfs/manifest",
    { config: { rateLimit: rateLimitForRoute("gtfsManifest") } },
    createGtfsManifestHandler(
      producerTileSource
        ? {
            // Advertise the producer's gen-dir bundleHash. `getLastKnownBundleHash`
            // is the same source: it returns the previous-good hash even when
            // the current manifest is mid-rename, mirroring scheduler semantics.
            getManifestSnapshot: () => producerTileSource.getManifestSnapshot(),
            getLastKnownBundleHash: () => producerTileSource.getCurrentBundleHash(),
          }
        : {
            getManifestSnapshot: () => scheduler.getManifestSnapshot(),
            getLastKnownBundleHash: () => scheduler.getLastKnownBundleHash(),
          },
    ),
  );
  app.post(
    "/api/telemetry",
    { bodyLimit: 8 * 1024, config: { rateLimit: rateLimitForRoute("telemetry") } },
    createTelemetryHandler({ emit: (e) => metricsRegistry.emitTelemetry(e) }),
  );
  app.post(
    "/api/client-report",
    { bodyLimit: 1 * 1024, config: { rateLimit: rateLimitForRoute("clientReport") } },
    createClientReportHandler({ inc: (labels) => metricsRegistry.clientEngineFailureReports.inc(labels) }),
  );

  if (process.env.NODE_ENV !== "production") {
    app.get("/api/debug/stop-routes-filter", getStopRoutesFilter);
  }

  // Serve OSRM data files for client-side pedestrian routing
  const OSRM_DATA_DIR = process.env.OSRM_DATA_DIR ?? path.join(process.cwd(), "data", "osrm");
  app.register(fastifyStatic, {
    root: OSRM_DATA_DIR,
    prefix: "/api/osrm/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "7d",
  });

  app.get("/api/city", async (_request, reply) => {
    const profile = getCityProfile(CITY_ID);
    reply.header("Cache-Control", "public, max-age=3600");
    if (!profile) {
      return reply.send({ id: CITY_ID, name: CITY_ID });
    }
    const geocoder = resolveApiCityGeocoder(profile);
    return reply.send({
      id: profile.id,
      name: profile.name,
      country: profile.country,
      center: profile.center,
      bbox: profile.bbox,
      modes: profile.modes,
      ...(geocoder && { geocoder }),
    });
  });

  // Declare rtPoller before listen so the thunk captures the variable binding.
  // The poller is assigned after listen (so feed loading doesn't block server
  // startup); requests that arrive before assignment see null and return 503 disabled.
  let rtPoller: GtfsRealtimePoller | null = null;
  registerRtHealthRoute(app, () => rtPoller);

  // Hydrate the bundle-success gauge from the on-disk manifest BEFORE the
  // first refresh fires, so the dashboard shows the true last-publish time
  // immediately after restart instead of 0 for hours.
  scheduler.hydrateBundleLastSuccessGauge();

  try {
    poiTileStatus.ready = await poiTileRoute.prewarm();
    if (!poiTileStatus.ready) {
      app.log.warn(
        { bundleDir: POI_BUNDLE_DIR },
        "POI tile corpus is absent; transit readiness is unaffected",
      );
    }
  } catch (error) {
    poiTileStatus.error = error instanceof Error ? error.message : String(error);
    app.log.error(
      { bundleDir: POI_BUNDLE_DIR, err: error },
      "POI tile preflight failed; transit readiness is unaffected and the route remains fail-closed",
    );
  }

  // Start listening before loading GTFS so health checks pass during feed download/parse
  await app.listen({ port: PORT, host: HOST });

  const metricsPort = parseInt(process.env.PORT_METRICS ?? "9100", 10);
  const metricsHost = resolveMetricsHost(process.env);
  const operatingProfile = process.env.PT_PROFILE ?? "ride";
  // Metrics sidecar is internal observability, not a hard dependency — if it
  // fails to bind (e.g. EADDRINUSE on 9100) we degrade to a warning rather
  // than taking down the main API. Shutdown is wired through the main app's
  // pre-listen onClose hook above (assigning `metricsApp` arms it) so the
  // sidecar listener never outlives the main server. Do NOT addHook here:
  // `app.listen` has already run, and Fastify throws
  // FST_ERR_INSTANCE_ALREADY_LISTENING on post-listen addHook.
  try {
    metricsApp = await startMetricsServer({ port: metricsPort, host: metricsHost, profile: operatingProfile });
    app.log.info({ port: metricsPort, host: metricsHost }, "metrics server listening");
  } catch (err) {
    app.log.warn(
      { port: metricsPort, host: metricsHost, err },
      "metrics server failed to start — continuing without it",
    );
  }

  // Load GTFS feed (can take minutes for large feeds like Paris IDFM).
  // Failure is non-fatal: the scheduler retries in the background so the
  // rest of the stack isn't blocked by one city's GTFS feed being unavailable.
  await scheduler.init();

  // Start GTFS real-time poller if one or more URLs are configured
  if (GTFS_RT_TRIP_UPDATES_URLS.length > 0) {
    rtPoller = new GtfsRealtimePoller({
      tripUpdatesUrls: GTFS_RT_TRIP_UPDATES_URLS,
      pollIntervalMs: RT_BACKEND_POLL_INTERVAL_MS,
      store: scheduler.getStore(),
      logger: app.log,
    });
    rtPoller.start();
  }
}

// Only boot the server when this file is the process entry-point.
// When index.ts is imported by a test, the side-effectful main() must not run
// or it tries to bind a port.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
