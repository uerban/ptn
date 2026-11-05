import {
  parseStops,
  parseRoutes,
  parseTrips,
  parseCalendar,
  parseCalendarDates,
  parseShapes,
  parseTransfers,
  parseFrequencies,
  parseAgency,
  buildCappedTripStringTable,
  type GtfsStop,
  type GtfsRoute,
  type GtfsTrip,
  type GtfsService,
  type GtfsCalendarDate,
  type GtfsFrequency,
  type GtfsShapePoint,
  type GtfsTransfer,
} from "./parser.js";
import { buildIndexesFromStreamed, createStopTimeStreamBuilder, type GtfsIndexes, type RoutingBuildInput } from "./index-builder.js";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { NOOP_TRACKER, type PhaseTracker } from "./phaseTracker.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readCaps } from "./caps.js";
import { assertCompressedSize, safeUnzip, safeStreamingUnzip } from "./zipSafety.js";
import { buildIdentity } from "./identity/buildIdentity.js";
import { buildShapesIndex } from "./shapesIndex.js";
import type { RoutingBundleShape } from "@pt/shared";
import { PatternMode } from "@pt/shared";
import type { ComputeBundleHashFeedFile } from "./computeBundleHash.js";

/** Read PatternMode from PT_PATTERN_MODE env. Defaults to CoveringMerge; set
 *  PT_PATTERN_MODE=off to roll back to the legacy canonical-only engine. */
export function readPatternMode(): PatternMode {
  const raw = process.env.PT_PATTERN_MODE;
  if (raw === PatternMode.Off) return PatternMode.Off;
  if (raw === PatternMode.Unbounded) return PatternMode.Unbounded;
  return PatternMode.CoveringMerge;
}

/**
 * Feature flag: route-shape ingest.
 *
 * Default ON. Set `PT_FEATURE_SHAPES=false` to skip shapes.txt parsing and
 * strip `shape_id` from trips — useful for tiny deployments where the shapes
 * artifact's RAM/wire cost is not worth the polyline fidelity (straight-line
 * fallback kicks in on the client).
 *
 * Evaluated lazily so tests can toggle `process.env.PT_FEATURE_SHAPES` around
 * a `loadGtfs(...)` call and have it take effect on that call.
 */
export function shapesEnabled(): boolean {
  return process.env.PT_FEATURE_SHAPES !== "false";
}

/**
 * Yield to the event loop between cold-load phases. This does NOT force a GC —
 * it drains the macrotask queue so a queued health/request isn't starved through
 * the whole multi-second build, and gives V8 an opportunity to scavenge
 * intermediates that were just released. Treat any RSS benefit as best-effort;
 * the structural peak reduction comes from not allocating redundant copies, not
 * from this yield. Shared by both ingest paths (`loadGtfs` here, `loadFromPtb`).
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export interface LoadResult {
  indexes: GtfsIndexes;
  canonical: CanonicalStore;
  routingInput: RoutingBuildInput;
  /** URL → ETag captured from the response (when the server provided one). */
  etags: Map<string, string>;
  /**
   * Raw shape points merged across all feeds. Undefined/empty when
   * `PT_FEATURE_SHAPES=false` or no feed had shapes.txt. Kept on the result
   * for diagnostic use; downstream consumers should read `shapes` (post-index)
   * rather than re-running `buildShapesIndex` themselves.
   */
  shapePoints?: GtfsShapePoint[];
  /**
   * Indexed, capped, encoded shape polylines ready to be handed to
   * `GtfsStore.setShapes`. Empty when shapes are disabled or no feed had any.
   */
  shapes?: RoutingBundleShape[];
  /**
   * Count of shapes dropped by `buildShapesIndex` (over caps or over
   * points-per-shape). Surfaced so the scheduler can log rebuild diagnostics.
   */
  droppedShapes?: number;
  /**
   * Per-feed identity records for `computeBundleHash`. One entry per fetched
   * URL; `path` is the URL itself (stable across loads, distinguishes feeds in
   * a multi-feed deploy) and `blobSha256` is the sha256 of the raw zip bytes.
   * The hash invalidates whenever any feed's bytes change, which is the
   * intended invalidation key for the tiled bundle.
   *
   * `readonly` because this is one-shot output never written-back; the
   * scheduler and `computeBundleHash` both consume via `readonly` types
   * downstream, and accidental mutation would silently change the
   * downstream bundle hash.
   */
  feedFiles: readonly ComputeBundleHashFeedFile[];
  /**
   * Parsed `transfers.txt` rows merged across all feeds. `transfers.txt` is an
   * optional GTFS file; this is `[]` when no feed contained one. Carried on the
   * result for downstream use — not yet consumed by routing.
   */
  transfers: GtfsTransfer[];
  /**
   * Parsed `frequencies.txt` rows merged across all feeds. Undefined when the
   * feed had no `frequencies.txt`. The scheduler/store export path carries
   * these rows for Phase B routing.
   * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
   */
  frequencies?: GtfsFrequency[];
  /**
   * Day-0 of the 90-day service-bitmask window as a YYYYMMDD integer (e.g.
   * 20260501). Present only when the load came from a PTB sidecar bundle —
   * `loadFromPtb` reads it from the PTB header and surfaces it here so the
   * scheduler can expose it for operator observability. Absent (undefined) for
   * network-GTFS loads where no pre-computed bitmask window exists.
   */
  feedStartDate?: number;
  /**
   * IANA timezone of the feed's agency. Populated on BOTH ingest paths:
   * the PTB sidecar path reads `meta.cityTzIana`; the network-GTFS path
   * parses `agency_timezone` from the first feed's `agency.txt` (the first
   * non-empty value across feeds — PTN models a single feed-level tz, spec
   * ). Absent (undefined) only when no feed carried an
   * `agency.txt`/`agency_timezone`.
   */
  cityTzIana?: string;
}

const REQUIRED_SMALL_FILES = ["stops.txt", "routes.txt", "trips.txt"];

interface FetchOutcome {
  /** Decompressed ZIP bytes, or null if the server returned 304 Not Modified. */
  zipBuffer: Uint8Array | null;
  etag: string | null;
}

async function fetchZip(url: string, etag?: string): Promise<FetchOutcome> {
  const caps = readCaps();

  if (url.startsWith("file://")) {
    if (process.env.PT_ALLOW_FILE_URLS !== "1") {
      throw new Error(
        `GTFS feed rejected — file:// scheme is disabled. Set PT_ALLOW_FILE_URLS=1 to enable (development only).`,
      );
    }
    const filePath = url.replace("file://", "");
    const buf = readFileSync(filePath);
    assertCompressedSize(buf.byteLength, caps.zipCompressedBytes, url);
    return {
      zipBuffer: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      etag: null,
    };
  }

  const headers: Record<string, string> = { Accept: "application/octet-stream" };
  if (etag) headers["If-None-Match"] = etag;

  const response = await fetch(url, { headers });
  if (response.status === 304) return { zipBuffer: null, etag: null };
  if (!response.ok) {
    throw new Error(`GTFS download failed (${url}): ${response.status} ${response.statusText}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    assertCompressedSize(Number(contentLength), caps.zipCompressedBytes, url);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  assertCompressedSize(body.byteLength, caps.zipCompressedBytes, url);
  return {
    zipBuffer: body,
    etag: response.headers.get("etag"),
  };
}

interface FeedSmallFiles {
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  calendar: GtfsService[];
  calendarDates: GtfsCalendarDate[];
  /** Optional — pre-shapes callers/tests may omit. Defaults to [] in merge. */
  shapePoints?: GtfsShapePoint[];
  /** Optional — feeds without transfers.txt omit it. Defaults to [] in merge. */
  transfers?: GtfsTransfer[];
  /** Optional — feeds without frequencies.txt omit it. Defaults to [] in merge. */
  frequencies?: GtfsFrequency[];
  /**
   * The feed's single feed-level IANA timezone, derived from the first
   * non-empty `agency_timezone` in `agency.txt`. Optional — undefined when the
   * feed had no `agency.txt` or a blank `agency_timezone`. Carried per-feed and
   * collapsed to the first feed's value in `loadGtfs` (not merged here).
   */
  agencyTz?: string;
}

/**
 * Merge small-file arrays from multiple feeds, deduplicating by primary key.
 * First occurrence wins on collision; a warning is logged to stderr.
 *
 * Exported for testing — see tests/gtfs/loader.test.ts.
 */
export function mergeSmallFiles(feeds: FeedSmallFiles[], sources?: string[]): FeedSmallFiles {
  const stops = new Map<string, GtfsStop>();
  const routes = new Map<string, GtfsRoute>();
  const trips = new Map<string, GtfsTrip>();
  const calendar = new Map<string, GtfsService>();
  const calendarDates: GtfsCalendarDate[] = [];
  const shapePoints: GtfsShapePoint[] = [];
  const transfers: GtfsTransfer[] = [];
  const frequencies: GtfsFrequency[] = [];

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const src = sources?.[i] ?? `feed[${i}]`;
    mergeByKey(stops, feed.stops, (s) => s.id, "stop_id", src);
    mergeByKey(routes, feed.routes, (r) => r.id, "route_id", src);
    mergeByKey(trips, feed.trips, (t) => t.tripId, "trip_id", src);
    mergeByKey(calendar, feed.calendar, (s) => s.serviceId, "service_id", src);
    pushAll(calendarDates, feed.calendarDates);
    if (feed.shapePoints) pushAll(shapePoints, feed.shapePoints);
    if (feed.transfers) pushAll(transfers, feed.transfers);
    if (feed.frequencies) pushAll(frequencies, feed.frequencies);
  }

  return {
    stops: Array.from(stops.values()),
    routes: Array.from(routes.values()),
    trips: Array.from(trips.values()),
    calendar: Array.from(calendar.values()),
    calendarDates,
    shapePoints,
    transfers,
    frequencies,
  };
}

function mergeByKey<T>(
  target: Map<string, T>,
  items: T[],
  keyFn: (item: T) => string,
  keyName: string,
  source: string,
): void {
  for (const item of items) {
    const key = keyFn(item);
    if (target.has(key)) {
      console.warn(`[GTFS] ${keyName} collision: '${key}' from ${source} dropped — first feed wins`);
      continue;
    }
    target.set(key, item);
  }
}

// Avoid `target.push(...source)` — V8 throws "Maximum call stack size
// exceeded" once the spread exceeds ~125k args, which trips on real GTFS
// feeds (calendar_dates.txt / shapes.txt).
function pushAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}

function extractAndParseSmallFiles(
  zipBuffer: Uint8Array,
  url: string,
  caps: ReturnType<typeof readCaps>,
): Promise<FeedSmallFiles> {
  const smallFiles = safeUnzip(
    zipBuffer,
    caps,
    (file) => file.name !== "stop_times.txt" && file.name.endsWith(".txt"),
  );

  for (const name of REQUIRED_SMALL_FILES) {
    if (!(name in smallFiles)) throw new Error(`Missing required GTFS file in ${url}: ${name}`);
  }
  if (!("calendar.txt" in smallFiles) && !("calendar_dates.txt" in smallFiles)) {
    throw new Error(`GTFS feed ${url} must contain at least one of calendar.txt or calendar_dates.txt`);
  }

  const empty = new Uint8Array(0);
  const get = (name: string) => smallFiles[name] ?? empty;

  // Shapes: parse only when the feature flag is on. `parseShapes` tolerates
  // an empty buffer by returning []. Failures are downgraded to "no shapes"
  // so a malformed shapes.txt never blocks a rebuild — the bundle's other
  // data is still useful.
  const shapesOn = shapesEnabled();
  const shapesPromise = shapesOn
    ? parseShapes(get("shapes.txt")).catch((err) => {
        console.error(
          `[gtfs] shapes.txt parse failed for ${url} — falling back to shapeless ingest`,
          err,
        );
        return [] as GtfsShapePoint[];
      })
    : Promise.resolve([] as GtfsShapePoint[]);

  // Transfers: optional GTFS file. `parseTransfers` tolerates an empty buffer
  // by returning []. A malformed transfers.txt is downgraded to "no transfers"
  // so it never blocks a rebuild — the bundle's other data is still useful.
  const transfersPromise = parseTransfers(get("transfers.txt")).catch((err) => {
    console.error(
      `[gtfs] transfers.txt parse failed for ${url} — falling back to no transfers`,
      err,
    );
    return [] as GtfsTransfer[];
  });

  // Frequencies: optional GTFS file. Parse failures degrade to no frequencies
  // rather than blocking a rebuild, matching the optional transfer/shapes paths.
  // Phase B uses exact_times=0 rows to prevent template-trip fallback.
  const frequenciesPromise = parseFrequencies(get("frequencies.txt")).catch((err) => {
    console.error(
      `[gtfs] frequencies.txt parse failed for ${url} — falling back to no frequencies`,
      err,
    );
    return [] as GtfsFrequency[];
  });

  return Promise.all([
    parseStops(get("stops.txt")),
    parseRoutes(get("routes.txt")),
    parseTrips(get("trips.txt")),
    parseCalendar(get("calendar.txt")),
    parseCalendarDates(get("calendar_dates.txt")),
    shapesPromise,
    transfersPromise,
    frequenciesPromise,
    parseAgency(get("agency.txt")),
  ]).then(([stops, routes, trips, calendar, calendarDates, shapePoints, transfers, frequencies, agency]) => {
    // When shapes are off, strip shape_id from trips so nothing downstream
    // (views, wire exports) leaks a shapeId that will never resolve.
    if (!shapesOn) {
      for (const t of trips) t.shapeId = undefined;
    }
    // PTN models a single feed-level timezone (single-timezone best practice — not per-agency):
    // take the FIRST non-empty agency_timezone. Undefined when agency.txt is absent or has no tz.
    const agencyTz = agency.find((a) => a.agencyTimezone !== "")?.agencyTimezone;
    return {
      stops,
      routes,
      trips,
      calendar,
      calendarDates,
      shapePoints,
      transfers,
      frequencies,
      agencyTz,
    };
  });
}

/**
 * Download, extract, and merge one or more GTFS feeds into a single `GtfsIndexes`.
 *
 * When `prevEtags` is provided, each URL is fetched conditionally (If-None-Match).
 * If every feed returns 304, the function returns null (no work to do). If any
 * feed has changed, unchanged feeds are refetched unconditionally so the merged
 * index contains current data for every source.
 *
 * Collisions on stop/route/trip/service IDs across feeds keep the first
 * occurrence and log a warning to stderr.
 */
export async function loadGtfs(
  urls: string[],
  prevEtags?: Map<string, string>,
  minTripsPerRoute: number = 0,
  tracker: PhaseTracker = NOOP_TRACKER,
): Promise<LoadResult | null> {
  if (urls.length === 0) throw new Error("loadGtfs requires at least one URL");

  const newEtags = new Map<string, string>();
  // `zipBuffer` is nulled per-entry once that feed's stop_times have been
  // streamed (see the streaming loop below) so the decompressed bytes can be
  // reclaimed before the index-build peak. The entry itself is kept (fetched is
  // still indexed/sorted), only the field is released.
  const fetched: { url: string; zipBuffer: Uint8Array | null }[] = [];
  const unchanged: string[] = [];

  tracker.beginPhase("fetch");
  for (const url of urls) {
    const { zipBuffer, etag } = await fetchZip(url, prevEtags?.get(url));
    if (zipBuffer === null) {
      unchanged.push(url);
      const carry = prevEtags?.get(url);
      if (carry) newEtags.set(url, carry);
    } else {
      fetched.push({ url, zipBuffer });
      if (etag) newEtags.set(url, etag);
    }
  }

  if (fetched.length === 0) return null;

  // Any feed changed → rebuild merged indexes. Refetch the 304'd ones
  // unconditionally so the merged result reflects every source.
  for (const url of unchanged) {
    const { zipBuffer, etag } = await fetchZip(url);
    if (zipBuffer === null) {
      throw new Error(`GTFS refetch returned 304 unexpectedly for ${url}`);
    }
    fetched.push({ url, zipBuffer });
    if (etag) newEtags.set(url, etag);
  }

  // Re-sort to match original URL order so "first wins" dedup is
  // deterministic regardless of which feeds returned 304.
  const urlOrder = new Map(urls.map((u, i) => [u, i]));
  fetched.sort((a, b) => (urlOrder.get(a.url) ?? 0) - (urlOrder.get(b.url) ?? 0));

  // Per-feed sha256 of raw zip bytes for the bundle hash. Computed up front (all
  // zipBuffers still present here) so the streaming loop below can null each
  // `zipBuffer` field once its stop_times have been consumed.
  const feedFiles: readonly ComputeBundleHashFeedFile[] = fetched.map(({ url, zipBuffer }) => ({
    path: url,
    blobSha256: createHash("sha256").update(zipBuffer!).digest("hex"),
  }));

  tracker.beginPhase("unzip-and-parse-small");
  const caps = readCaps();

  const perFeed: FeedSmallFiles[] = [];
  for (const { url, zipBuffer } of fetched) {
    perFeed.push(await extractAndParseSmallFiles(zipBuffer!, url, caps));
  }
  tracker.beginPhase("merge-and-release-perFeed");
  const sources = fetched.map((f) => f.url);
  const merged = mergeSmallFiles(perFeed, sources);
  // Single feed-level tz = the first feed (in URL order) that carried an
  // agency_timezone. Captured BEFORE perFeed is released below. Undefined when
  // no feed had an agency.txt/agency_timezone — the scheduler's refresh-site
  // setter is guarded on this being truthy so an absent tz never clobbers a
  // prior value.
  const cityTzIana = perFeed.find((f) => f.agencyTz)?.agencyTz;
  // Release the small-file accumulator so its decompressed stops/routes/trips
  // buffers can be garbage-collected before the 20 M-row stop_times streaming
  // peak. Without this, Paris IDFM holds ~120 MB of redundant decompressed
  // data alive through the entire index build.
  (perFeed as unknown[]).length = 0;

  tracker.beginPhase("build-identity");
  const buildDateIso = new Date().toISOString().slice(0, 10);
  const horizonDays = parseInt(process.env.PT_BITMASK_HORIZON_DAYS ?? "90", 10);
  const identity = buildIdentity({
    stops: merged.stops,
    routes: merged.routes,
    trips: merged.trips,
    services: merged.calendar,
    calendarDates: merged.calendarDates,
    buildDateIso,
    horizonDays,
  });

  // Build trips index over the merged trip set so stop_times streaming
  // can resolve tripId → routeId across every feed.
  tracker.beginPhase("stream-stop-times");
  const tripsIndex = new Map(merged.trips.map((t) => [t.tripId, t]));

  const tripStrings = buildCappedTripStringTable(
    merged.trips.map((t) => t.tripId),
    caps.trips,
  );
  // Network-GTFS has no PTB global trip ordinals, but the frontend frequency
  // join still needs a stable ordinal namespace within this exported bundle.
  // Use the same deterministic merged-trip interner order that stop_times and
  // the canonical store are built from, so trips[].ptbTripIdx and top-level
  // frequencies[].tripIdx agree after refresh.
  for (const t of merged.trips) {
    t.ptbTripIdx ??= tripStrings.indexOf(t.tripId);
  }
  const builder = createStopTimeStreamBuilder(tripsIndex, undefined, tripStrings, readPatternMode());

  for (const entry of fetched) {
    builder.beginFeed();
    let foundStopTimes = false;

    await safeStreamingUnzip(
      entry.zipBuffer!,
      caps,
      (name) => name === "stop_times.txt",
      {
        onFile(_name, chunk, _final) {
          foundStopTimes = true;
          builder.push(chunk);
        },
      },
    );

    if (!foundStopTimes) {
      throw new Error(`Missing stop_times.txt in ${entry.url}`);
    }

    await builder.endFeed();
    // This feed's stop_times are now streamed into the builder; its raw
    // decompressed bytes are dead. Release the field so V8 can reclaim it
    // before the next feed (or the index build) allocates — feedFiles sha256
    // was computed up front and perFeed is already released, so nothing reads
    // zipBuffer past this point. Yield so a scavenge has a chance to run.
    entry.zipBuffer = null;
    await yieldToEventLoop();
  }

  tracker.beginPhase("build-indexes");
  const {
    stopTimesIndex,
    tripStrings: finishedTripStrings,
    stopRouteTripCounts,
    routeTrips,
  } = await builder.finish();

  // Build the shapes artifact (if enabled) before the indexes so orphan shape
  // refs on trips can be stripped before canonical is built — keeps the
  // canonical trip records in sync with the shapes that actually get emitted.
  const shapePoints = merged.shapePoints ?? [];
  const shapesOn = shapesEnabled();
  const { shapes, droppedShapes } = shapesOn
    ? (() => {
        const { shapes, droppedCount } = buildShapesIndex({
          shapePoints,
          trips: merged.trips,
          caps: {
            shapesCount: caps.shapesCount,
            pointsPerShape: caps.pointsPerShape,
            shapesEncodedBytes: caps.shapesEncodedBytes,
          },
        });
        if (droppedCount > 0) {
          const kept = new Set(shapes.map((s) => s.shapeId));
          for (const t of merged.trips) {
            if (t.shapeId && !kept.has(t.shapeId)) t.shapeId = undefined;
          }
        }
        return { shapes, droppedShapes: droppedCount };
      })()
    : { shapes: [] as RoutingBundleShape[], droppedShapes: 0 };

  const { indexes, canonical, routingInput } = buildIndexesFromStreamed(
    merged.stops,
    merged.routes,
    merged.trips,
    stopTimesIndex,
    finishedTripStrings,
    stopRouteTripCounts,
    routeTrips,
    merged.calendar,
    merged.calendarDates,
    minTripsPerRoute,
    identity,
  );

  tracker.beginPhase("finalize");
  tracker.endPhase();
  return {
    indexes,
    canonical,
    routingInput,
    etags: newEtags,
    shapePoints,
    shapes,
    droppedShapes,
    transfers: merged.transfers ?? [],
    frequencies: merged.frequencies && merged.frequencies.length > 0 ? merged.frequencies : undefined,
    feedFiles,
    cityTzIana,
  };
}
