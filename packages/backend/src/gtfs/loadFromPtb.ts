import { readFileSync } from "node:fs";
import {
  loadPtb,
  routeTypeToMode,
  bytesPerService,
  type InternTable,
  type PtbBundle,
  type RouteDirectionPattern,
  type RoutingBundleShape,
  type ServiceBitmask,
} from "@pt/shared";
import { feedStartDateIso, readSidecars, type ShapeGroup } from "@pt/shared/ptb/sidecars";
import type {
  CompactStopTimes,
  GtfsCalendarDate,
  GtfsFrequency,
  GtfsRoute,
  GtfsService,
  GtfsShapePoint,
  GtfsStop,
  GtfsTransfer,
  GtfsTrip,
  TripStringTable,
} from "./parser.js";
import { buildCappedTripStringTable } from "./parser.js";
import {
  buildIndexesFromStreamed,
  U32PairBuilder,
  type GtfsIndexes,
  type RoutingBuildInput,
} from "./index-builder.js";
import { PatternMode, patternsEnabled, groupTripsByPattern } from "@pt/shared";
import { readCaps } from "./caps.js";
import { shapesEnabled, readPatternMode, yieldToEventLoop, type LoadResult } from "./loader.js";
import { buildShapesIndex } from "./shapesIndex.js";
import type { Identity } from "./identity/types.js";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import type { ComputeBundleHashFeedFile } from "./computeBundleHash.js";

/**
 * Phase B sidecar loader: reads the Rust producer's PTB binary + the two JSON
 * sidecars (.meta.json, .shapes.json) and constructs the same LoadResult
 * shape `loadGtfs` produces from a fresh zip download — without touching the
 * network.
 *
 * PTB carries `routing primitives only` (per Q1.E in the Phase B plan).
 * Several fields the existing GTFS path produces are not in PTB and are
 * synthesised here:
 *
 *   - service_id strings — PTB stores numeric `serviceIdx` per trip; we
 *     synthesise `svc:{idx}` strings and key the ServiceBitmask map by them
 *     so the rest of the stack sees a consistent string identifier.
 *   - per-trip stop_times boundaries — PTB carries an explicit
 *     `tripStarts[]` prefix-sum (num_trips+1 u32 offsets into the StopTimes
 *     rows, in sorted-trip order). We slice `stopTimes[tripStarts[i] ..
 *     tripStarts[i+1]]` to recover trip `i`'s rows exactly. Because StopTimes
 *     is grouped by sorted trip index, `tripIdx === i` for each slice — no
 *     heuristic, no assumption about CSV row order.
 *   - calendar / calendar_dates — PTB stores pre-computed per-service
 *     active-day bitmasks. We surface those via Identity AND expand them into
 *     `calendarDates` rows (one exceptionType=1 "added" entry per active day in
 *     the 90-day window). The serving path reads service activity from the
 *     canonical/exported calendar (store.ts `getActiveServiceIdsForDate`,
 *     buildTileForCell, the frontend `resolveActiveServices`), NOT from
 *     `identity.bitmasks` — so without this expansion every service would be
 *     inactive everywhere in PTB mode. The placeholder `services` rows carry
 *     all-false weekday flags / empty date range; the added-date exceptions are
 *     what actually drive activity (exceptionType=1 short-circuits the weekday
 *     check in both backend and frontend resolvers).
 *   - parent_station — resolved from the decoded `stopParents` (the dense
 *     `parent_idx` column); empty string for stops with no parent.
 *   - direction_id, shape_id — carried in the 24 B trip record;
 *     forwarded on GtfsTrip.directionId / .shapeId.
 *   - wheelchair — forwarded on GtfsTrip/GtfsStop.
 *   - transfers (GTFS transfers.txt) — carried in the `0xF8 Transfers` region;
 *     `synthTransfers` resolves the interned indices back to string ids and
 *     returns the same `GtfsTransfer[]` shape `loadGtfs` produces. Carried only
 *     in S0 — nothing consumes `LoadResult.transfers` yet.
 *     GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
 *
 * Lasso / loop routes: a trip may revisit a stop (Vilnius 6G stem→loop→stem;
 * GTFS best-practices #lasso-routes / #loop-routes — see the route-trips
 * alignment below). The canonical stop pattern keeps the repeat and each
 * occurrence is aligned to its own departure via a per-trip cursor over the
 * stop's position list. KNOWN LIMITATION: a pathological sub-trip that, under
 * the SAME route_id, serves ONLY the inbound half of a lasso would have its rows
 * mapped onto the OUTBOUND occurrences (the cursor takes the first unused
 * position per stop), which can make that trip's per-position departures
 * non-monotonic. This is not the reported case and not produced by the
 * single-full-extent-trip lasso shape; the GTFS-sanctioned alternative is to
 * split such travel across multiple trip_ids joined by `block_id`
 * (https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes).
 *
 * Network I/O: zero. All three files are read from local disk.
 */
/**
 * Release the two largest per-stop_time columns from a decoded bundle once the
 * streamed-shape build has consumed them. `PtbBundle.stopTimes` is non-optional,
 * so nulling it needs a structural cast — isolating that here (rather than an
 * inline cast at the call site) keeps the lifetime documented and greppable, and
 * confines the type escape hatch to one named function. Callers MUST NOT read
 * `ptnb.stopTimes` / `ptnb.boarding` after calling this. Trough reduction (frees
 * memory before the index build); does not lower the cold-load peak.
 */
function releaseStopTimeColumns(ptnb: PtbBundle): void {
  (ptnb as { stopTimes?: unknown }).stopTimes = undefined;
  ptnb.boarding = undefined;
}

export async function loadFromPtb(
  bundlePath: string,
  minTripsPerRoute: number,
): Promise<LoadResult> {
  const buf = readFileSync(bundlePath);
  const ptnb = loadPtb(buf);
  const { meta, shapes: rawShapes } = readSidecars(bundlePath);

  // Anchor the 90-day service-bitmask window to the header's feedStartDate
  // (YYYYMMDD integer, written by the Rust producer). The sidecar ISO string is
  // kept for provenance only — it must NOT be used as the math anchor because
  // the PTB header is the single source of truth for this value.
  const anchorIso = feedStartDateIso(ptnb.feedStartDate);

  const stops = synthStops(ptnb);
  const routes = synthRoutes(ptnb);
  const trips = synthTrips(ptnb);
  const services = synthServices(ptnb);
  const calendarDates = synthCalendarDates(ptnb, anchorIso);

  const caps = readCaps();
  const tripStrings = buildCappedTripStringTable(
    trips.map((t) => t.tripId),
    caps.trips,
  );
  await yieldToEventLoop();

  // PTB carries an explicit tripStarts[] prefix-sum, so trip boundaries are
  // exact: stopTimes[tripStarts[i] .. tripStarts[i+1]] is trip i's rows, and
  // tripIdx === i because StopTimes is grouped by sorted trip index.
  // `buildPtnbStreamedShape` reads `ptnb.{stopTimes,boarding,tripStarts}`
  // directly and slices per-trip in a single pass — no up-front `groupedRows`
  // copy (that materialised a full second JS-object copy of every stop_time,
  // ~⅓ of the cold-load high-water mark; removed for the redeploy memory spike).
  const patternMode = readPatternMode();
  const { stopTimesIndex, stopRouteTripCounts, routeTrips } = buildPtnbStreamedShape(
    ptnb,
    trips,
    tripStrings,
    patternMode,
  );

  // The remainder of this function only reads ptnb.{stops,routes,trips,transfers,
  // serviceBitmasks,numServices,stopParents,feedStartDate}. Release the two
  // largest per-stop_time columns now so they can be reclaimed before the index
  // build allocates the canonical/routing structures (trough reduction — does
  // not lower the cold-load peak, which is cut by dropping the groupedRows copy
  // above).
  releaseStopTimeColumns(ptnb);
  await yieldToEventLoop();

  const identity = buildPtbIdentity(ptnb, stops, routes, trips, services, tripStrings, anchorIso);

  const { indexes, canonical, routingInput } = buildIndexesFromStreamed(
    stops,
    routes,
    trips,
    stopTimesIndex,
    tripStrings,
    stopRouteTripCounts,
    routeTrips,
    services,
    calendarDates,
    minTripsPerRoute,
    identity,
  );
  await yieldToEventLoop();

  const shapesOn = shapesEnabled();
  const shapePoints = shapesOn ? sidecarShapesToPoints(rawShapes.shapes) : [];
  const { shapes, droppedShapes } = shapesOn
    ? buildShapesFromSidecar(shapePoints, rawShapes.shapes, caps)
    : { shapes: undefined as RoutingBundleShape[] | undefined, droppedShapes: undefined as number | undefined };

  const feedFiles: readonly ComputeBundleHashFeedFile[] = meta.feeds.map((f) => ({
    path: f.url,
    blobSha256: f.blobSha256,
  }));
  const etags = new Map<string, string>();
  for (const f of meta.feeds) {
    if (f.etag) etags.set(f.url, f.etag);
  }

  return {
    indexes,
    canonical,
    routingInput,
    etags,
    feedFiles,
    feedStartDate: ptnb.feedStartDate,
    // Feed agency tz from the `.meta.json` sidecar (`meta.cityTzIana`).
    // Absent when the producer had no city tz.
    cityTzIana: meta.cityTzIana,
    // The PTB carries GTFS transfers.txt rules in the Transfers region; decode
    // them back to the same string-id `GtfsTransfer` shape `loadGtfs` produces
    // so both ingest paths converge. Empty when the feed had no transfers.txt.
    transfers: synthTransfers(ptnb),
    // PTB 0x17 Frequencies region (optional);
    // decode back to the same string-id `GtfsFrequency` shape `parseFrequencies`
    // produces. Undefined when the region is absent (feed had no frequencies.txt).
    // The scheduler/store export path carries these rows for Phase B routing.
    frequencies: synthFrequencies(ptnb),
    ...(shapesOn ? { shapePoints, shapes, droppedShapes } : {}),
  };
}

// ── Synthesis: PTB rows → source-GTFS arrays ─────────────────────────────

function synthStops(ptnb: PtbBundle): GtfsStop[] {
  // Resolve parent_station from the decoded `stopParents` pairs: post-finalize
  // stop index (childIdx) -> the parent stop's stop_id string. A stop without a
  // parent degrades to "".
  const parentStopIdByChildIdx = new Map<number, string>();
  for (const { childIdx, parentIdx } of ptnb.stopParents) {
    parentStopIdByChildIdx.set(childIdx, ptnb.stops[parentIdx]!.stopId);
  }
  return ptnb.stops.map((s, i) => ({
    id: s.stopId,
    name: s.stopName,
    lat: s.stopLat,
    lon: s.stopLon,
    parentStation: parentStopIdByChildIdx.get(i) ?? "",
    wheelchairBoarding: s.wheelchairBoarding,
  }));
}

function synthRoutes(ptnb: PtbBundle): GtfsRoute[] {
  return ptnb.routes.map((r) => ({
    id: r.routeId,
    // agencyId is available on PtbRoute (pooled, lossless) but intentionally
    // not forwarded to GtfsRoute — no current consumer reads it from this path.
    shortName: r.routeShortName,
    longName: r.routeLongName,
    mode: routeTypeToMode(r.routeType),
    color: r.routeColor,
    textColor: r.routeTextColor,
  }));
}

function synthTrips(ptnb: PtbBundle): GtfsTrip[] {
  return ptnb.trips.map((t, i) => {
    const route = ptnb.routes[t.routeIdx];
    if (!route) {
      // Producer and loader must be in lockstep — a trip pointing past the routes
      // table is a producer/loader contract violation, not a soft case. Failing
      // loud here surfaces a PTB-version drift instead of producing a trip
      // with routeId="" that downstream maps silently drop.
      throw new RangeError(
        `loadFromPtb: trips[${i}] (tripId=${t.tripId}) has routeIdx=${t.routeIdx} ` +
          `but routes table has only ${ptnb.routes.length} entries — producer/loader version drift`,
      );
    }
    return {
      tripId: t.tripId,
      routeId: route.routeId,
      serviceId: serviceIdFor(t.serviceIdx),
      headsign: t.headsign,
      ptbTripIdx: i,
      wheelchairAccessible: t.wheelchairAccessible,
      bikesAllowed: t.bikesAllowed,
      // The PTB carries direction_id and shape_id; forward them so
      // buildPtnbStreamedShape can use directionId for pattern bucketing
      // (matching index-builder's `${directionId}:${headsign}` composite key)
      // and the shape pipeline has the per-trip shape reference.
      directionId: (t.directionId === 0 || t.directionId === 1) ? t.directionId : undefined,
      shapeId: t.shapeId || undefined,
    };
  });
}

function synthServices(ptnb: PtbBundle): GtfsService[] {
  // PTB carries bitmasks pre-computed; the GtfsService entries returned here
  // are placeholders so downstream `buildServicesIndex` registers every
  // service id. Weekday flags / date range stay empty — actual active days are
  // emitted as calendar_dates "added" exceptions by `synthCalendarDates`,
  // which is what the serving path resolves against (see file header).
  const out: GtfsService[] = [];
  for (let i = 0; i < ptnb.numServices; i++) {
    out.push({
      serviceId: serviceIdFor(i),
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: false,
      sunday: false,
      startDate: "",
      endDate: "",
    });
  }
  return out;
}

/**
 * Expand each service's PTB active-day bitmask into `calendar_dates` rows.
 *
 * The serving stack (store.ts `getActiveServiceIdsForDate`, `buildTileForCell`,
 * the frontend `resolveActiveServices`/`serviceDay`) determines whether a
 * service runs on a date from the canonical/exported calendar — weekday flags,
 * date range, and calendar_dates exceptions — NOT from `identity.bitmasks`.
 * PTB carries the bitmask; we materialise it as one exceptionType=1
 * ("added") row per active day. exceptionType=1 is honoured ahead of the
 * weekday/range check in every resolver, so the all-false placeholder
 * `services` rows never suppress these dates. The window is bounded by the
 * runtime `windowDays` (default 90, but a 400-day PTB carries a 400-day window),
 * so this is at most numServices × windowDays rows. Iterating the full runtime
 * window is load-bearing: a hardcoded 90 would silently drop every active day
 * in 90..windowDays-1.
 */
function synthCalendarDates(ptnb: PtbBundle, feedStartDate: string): GtfsCalendarDate[] {
  const out: GtfsCalendarDate[] = [];
  const bytesPer = bytesPerService(ptnb.windowDays);
  for (let i = 0; i < ptnb.numServices; i++) {
    const base = i * bytesPer;
    const serviceId = serviceIdFor(i);
    for (let d = 0; d < ptnb.windowDays; d++) {
      const byte = ptnb.serviceBitmasks[base + (d >> 3)] ?? 0;
      if (((byte >> (d & 7)) & 1) === 1) {
        out.push({ serviceId, date: addDaysYYYYMMDD(feedStartDate, d), exceptionType: 1 });
      }
    }
  }
  return out;
}

/**
 * Add `days` calendar days to an ISO `YYYY-MM-DD` anchor and format as
 * `YYYYMMDD`. Built in local time to mirror store.ts `formatDateYYYYMMDD` and
 * the frontend's local date formatting that the exception keys are matched
 * against — the bitmask anchor is a pure calendar date, not an instant.
 */
function addDaysYYYYMMDD(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y!, m! - 1, d! + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function serviceIdFor(idx: number): string {
  return `svc:${idx}`;
}

/**
 * Decode the PTB Transfers region into the string-id `GtfsTransfer` shape
 * the network `loadGtfs` path produces, so both ingest paths converge.
 *
 * `loadPtb` returns each rule with interner INDICES (and `undefined` for absent
 * optional scope / min-transfer-time). We resolve those indices back to the
 * `stopId`/`routeId`/`tripId` strings via the already-decoded `ptnb.stops`/
 * `.routes`/`.trips` arrays (index === array position). A rule referencing an
 * out-of-range index is a producer/loader contract violation; we surface it loudly
 * (like `synthTrips`' routeIdx guard) rather than emitting a transfer with an
 * empty id that downstream maps would silently drop.
 *
 * Carried only in S0 — `LoadResult.transfers` is consumed by nothing yet; S1–S3
 * apply the rules.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
function synthTransfers(ptnb: PtbBundle): GtfsTransfer[] {
  const stopId = (i: number | undefined): string | undefined => {
    // Absent only on a PTB v2 linked row; out-of-range still throws below.
    if (i === undefined) return undefined;
    const s = ptnb.stops[i];
    if (!s) {
      throw new RangeError(
        `loadFromPtb: transfer references stopIdx=${i} but stops table has only ${ptnb.stops.length} entries — producer/loader version drift`,
      );
    }
    return s.stopId;
  };
  // A defined-but-out-of-range optional index is producer/loader drift, not an
  // absent scope (the sentinel 0xFFFFFFFF was already mapped to undefined by
  // decodeTransfers). Throw on it, symmetric with stopId() — silently
  // downgrading to undefined would broaden a scoped rule to all-routes/all-trips.
  const routeId = (i: number | undefined): string | undefined => {
    if (i === undefined) return undefined;
    const r = ptnb.routes[i];
    if (!r) {
      throw new RangeError(
        `loadFromPtb: transfer references routeIdx=${i} but routes table has only ${ptnb.routes.length} entries — producer/loader version drift`,
      );
    }
    return r.routeId;
  };
  const tripId = (i: number | undefined): string | undefined => {
    if (i === undefined) return undefined;
    const t = ptnb.trips[i];
    if (!t) {
      throw new RangeError(
        `loadFromPtb: transfer references tripIdx=${i} but trips table has only ${ptnb.trips.length} entries — producer/loader version drift`,
      );
    }
    return t.tripId;
  };

  return ptnb.transfers.map((t) => ({
    fromStopId: stopId(t.fromStopIdx),
    toStopId: stopId(t.toStopIdx),
    transferType: t.transferType,
    minTransferSecs: t.minTransferSecs,
    fromRouteId: routeId(t.fromRouteIdx),
    toRouteId: routeId(t.toRouteIdx),
    fromTripId: tripId(t.fromTripIdx),
    toTripId: tripId(t.toTripIdx),
  }));
}

/**
 * Decode the PTB `0x17 Frequencies` region back to the `GtfsFrequency[]` shape
 * that `parseFrequencies` in `parser.ts` produces, so both ingest paths converge.
 *
 * Each `PtbFrequencyRow` stores `startSecs`/`endSecs` as raw seconds (overnight-safe,
 * no 86400 modulo). `GtfsFrequency` also stores them as seconds, so the mapping is
 * direct — no string conversion needed.
 *
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
function synthFrequencies(ptnb: PtbBundle): GtfsFrequency[] | undefined {
  if (!ptnb.frequencies || ptnb.frequencies.length === 0) return undefined;
  return ptnb.frequencies.map((f) => {
    const t = ptnb.trips[f.tripIdx];
    if (!t) {
      throw new RangeError(
        `loadFromPtb: frequency row references tripIdx=${f.tripIdx} but trips table has only ${ptnb.trips.length} entries — producer/loader version drift`,
      );
    }
    return {
      tripId: t.tripId,
      startSecs: f.startSecs,
      endSecs: f.endSecs,
      headwaySecs: f.headwaySecs,
      exactTimes: f.exactTimes,
    };
  });
}

// ── Streamed-shape construction ────────────────────────────────────────────

interface StreamedShape {
  stopTimesIndex: Map<string, CompactStopTimes>;
  stopRouteTripCounts: Map<string, Map<string, number>>;
  /**
   * Ordered list of route records. Under Off: one per canonical route (byte-identical to
   * pre-pattern behaviour). Under Unbounded: one per distinct stop-sequence pattern
   * (repeated routeId), matching the production streaming path in index-builder.ts.
   */
  routeTrips: RouteTripsData[];
}

interface RouteTripsData {
  /** The bare GTFS route_id. */
  routeId: string;
  stopIds: string[];
  trips: RouteTripEntryLike[];
  directionPatterns: RouteDirectionPattern[];
}

interface RouteTripEntryLike {
  tripId: string;
  serviceId: string;
  headsign: string;
  departureSecs: Uint32Array;
  dwellSecs?: Uint16Array;
  /**
 * Sparse per-stop GTFS pickup_type / drop_off_type, aligned to the enclosing record's `stopIds`
 * (parallel to `dwellSecs`). `pickup_type == 1` = alight-only; `drop_off_type == 1` =
 * board-only. Omitted when every value is default 0 (the norm / region-absent case). Carried
 * through to the routing bundle; the scan consumes them. Sourced from the decoded `0xFA` byte;
 * `continuous_*` are not forwarded (YAGNI).
 */
  pickupTypes?: Uint8Array;
  dropOffTypes?: Uint8Array;
}

const UNSERVED_STOP_SENTINEL = 0xffffffff;
const MISSING_DEP_SENTINEL = 0xffffffff;

/**
 * Exported for unit testing only (`loadFromPtb.test.ts`). The committed `.ptb`
 * fixtures cannot express a non-default `0xFA` boarding byte or non-zero
 * `arrDiff` (the `TinyStopTime` fixture builder has no such fields), so the
 * boarding-byte decode and the arrDiff→dwell fill are exercised by constructing
 * a minimal `PtbBundle` directly against this function.
 */
export function buildPtnbStreamedShape(
  ptnb: PtbBundle,
  trips: GtfsTrip[],
  tripStrings: TripStringTable,
  mode: PatternMode = PatternMode.Off,
): StreamedShape {
  // Per-stop CompactStopTimes via the same U32PairBuilder the streaming path uses.
  const stopBuilders = new Map<string, U32PairBuilder>();

  // (stopId, routeId) → Set<tripId> for the count map.
  const tripCountSets = new Map<string, Map<string, Set<string>>>();

  // Per-route trip rows assembled here, mirroring buildRouteTripsIndex.
  // Key: routeId.
  const perRoute = new Map<string, {
    tripIdxs: number[];
  }>();

  // Per-trip stop sequences, used to derive route-level stopIds (longest trip)
  // and to fill per-trip departureSecs arrays.
  const tripStopSeqs: Array<
    Array<{ stopId: string; depSecs: number; arrDiff: number; stopSeq: number; pickupType: number; dropOffType: number }>
  > = [];
  for (let i = 0; i < trips.length; i++) tripStopSeqs.push([]);

  // Single pass over each trip's StopTimes slice, read straight from the PTB
  // columns (no intermediate `groupedRows` copy). PTB carries an explicit
  // tripStarts[] prefix-sum, so trip boundaries are exact:
  // stopTimes[tripStarts[ti] .. tripStarts[ti+1]] is trip ti's rows, and
  // tripIdx === ti because StopTimes is grouped by sorted trip index.
  // PTB v2 quarantined frequency trips are never routed, not even as their
  // scheduled template (mirrors ptbToBundleWire and pt_core's v2 index).
  const quarantined = new Set(ptnb.v2?.quarantinedFrequencyTrips ?? []);
  for (let ti = 0; ti < trips.length; ti++) {
    const trip = trips[ti];
    if (!trip || quarantined.has(ti)) continue;
    const tripId = trip.tripId;
    const tripIxInStrings = tripStrings.intern(tripId);

    let routeBucket = perRoute.get(trip.routeId);
    if (!routeBucket) {
      routeBucket = { tripIdxs: [] };
      perRoute.set(trip.routeId, routeBucket);
    }
    routeBucket.tripIdxs.push(ti);

    const lo = ptnb.tripStarts[ti]!;
    const hi = ptnb.tripStarts[ti + 1]!;
    const seq = tripStopSeqs[ti]!;
    for (let r = lo; r < hi; r++) {
      const st = ptnb.stopTimes[r]!;
      const stop = ptnb.stops[st.stopIdx];
      if (!stop) continue;
      const stopId = stop.stopId;
      const depSecs = st.depSecs;

      // Decode the per-stop_time boarding byte from the flat `ptnb.boarding`
      // column — same global-row index space as `stopTimes[r]`, so the index is
      // `r`. Absent region ⇒ default 0x50 (pickup 0 / drop_off 0); `continuous_*`
      // are not forwarded (YAGNI). The decoded types ride the stopSeq sort below
      // alongside depSecs/arrDiff (else folded/lasso members desync — mirrors
      // ptbToBundleWire.ts).
      const b = ptnb.boarding?.[r] ?? 0x50;

      // CompactStopTimes per-stop entries skip rows with a missing-departure
      // sentinel — they would otherwise sort to the front and confuse
      // departure lookups. arrDiff is carried into the routeTrips fill below
      // even when dep is present, since arrDiff=0 is the common case.
      if (depSecs !== MISSING_DEP_SENTINEL) {
        let pair = stopBuilders.get(stopId);
        if (!pair) {
          pair = new U32PairBuilder();
          stopBuilders.set(stopId, pair);
        }
        pair.push(tripIxInStrings, depSecs);
      }

      // stop_route trip count: count each (stop, route, trip) once.
      let routeMap = tripCountSets.get(stopId);
      if (!routeMap) {
        routeMap = new Map();
        tripCountSets.set(stopId, routeMap);
      }
      let tripSet = routeMap.get(trip.routeId);
      if (!tripSet) {
        tripSet = new Set();
        routeMap.set(trip.routeId, tripSet);
      }
      tripSet.add(tripId);

      seq.push({
        stopId,
        depSecs,
        arrDiff: st.arrDiff,
        stopSeq: st.stopSeq,
        pickupType: b & 0b11,
        dropOffType: (b >> 2) & 0b11,
      });
    }
  }

  const stopTimesIndex = new Map<string, CompactStopTimes>();
  for (const [stopId, builder] of stopBuilders) {
    stopTimesIndex.set(stopId, builder.finalize());
  }
  // Drop the per-stop U32PairBuilders now they're finalized into stopTimesIndex —
  // they're the heaviest intermediate and the routeTrips build below doesn't need
  // them. .clear() releases the builder objects for GC (the empty Map is negligible).
  stopBuilders.clear();

  const stopRouteTripCounts = new Map<string, Map<string, number>>();
  for (const [stopId, routeMap] of tripCountSets) {
    const countMap = new Map<string, number>();
    for (const [routeId, tripSet] of routeMap) countMap.set(routeId, tripSet.size);
    stopRouteTripCounts.set(stopId, countMap);
  }
  // Likewise release the Map→Map→Set<string> trip-count structure once folded
  // into the integer stopRouteTripCounts.
  tripCountSets.clear();

  const routeTrips: RouteTripsData[] = [];
  for (const [routeId, bucket] of perRoute) {
    // Canonical stopIds come from the longest trip in this route — same
    // policy as buildRouteTripsIndex (longest-trip-derived sequence avoids
    // express variants producing incomplete sequences).
    let longestTripIdx = bucket.tripIdxs[0]!;
    let longestLen = tripStopSeqs[longestTripIdx]?.length ?? 0;
    for (let i = 1; i < bucket.tripIdxs.length; i++) {
      const ti = bucket.tripIdxs[i]!;
      const len = tripStopSeqs[ti]?.length ?? 0;
      if (len > longestLen) { longestLen = len; longestTripIdx = ti; }
    }
    const longest = [...tripStopSeqs[longestTripIdx]!].sort((a, b) => a.stopSeq - b.stopSeq);
    const stopIds = longest.map((r) => r.stopId);
    // Lasso / loop routes revisit a stop within ONE trip, so the canonical
    // stopIds contain repeats. Map each stopId to the LIST of its canonical
    // positions (ascending) and consume them in stopSeq order via a per-trip
    // cursor — a single-position map (last-write-wins) would leave the outbound
    // occurrence of every repeated stop unserved. Must match the Rust builder
    // (crates/pt-core/src/engine/index.rs) and ptbToBundleWire.ts byte-for-byte
    // for the differential gate. GTFS best-practices — check the canonical
    // case/example before changing this alignment:
    //   https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    //   https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    const stopIdToPositions = new Map<string, number[]>();
    stopIds.forEach((s, i) => {
      let positions = stopIdToPositions.get(s);
      if (!positions) { positions = []; stopIdToPositions.set(s, positions); }
      positions.push(i);
    });

    const tripsOut: RouteTripEntryLike[] = [];
    for (const ti of bucket.tripIdxs) {
      const trip = trips[ti]!;
      const departureSecs = new Uint32Array(stopIds.length).fill(UNSERVED_STOP_SENTINEL);
      let dwellSecs: Uint16Array | undefined;
      // Parallel to dwellSecs: sparse canonical-aligned pickup/drop_off types,
      // lazy-alloc, omitted when all-default 0. The byte already rode the stopSeq
      // sort on `row` (enriched at the slice site).
      let pickupTypes: Uint8Array | undefined;
      let dropOffTypes: Uint8Array | undefined;
      const cursor = new Map<string, number>();
      // Rows must be walked in stopSeq order for occurrence-consumption (the
      // canonical above sorts; this per-trip fill previously relied on a
      // sequence-insensitive Map and did not).
      const rows = [...tripStopSeqs[ti]!].sort((a, b) => a.stopSeq - b.stopSeq);
      for (const row of rows) {
        const positions = stopIdToPositions.get(row.stopId);
        if (positions === undefined) continue;
        const k = cursor.get(row.stopId) ?? 0;
        if (k >= positions.length) continue; // trip visits this stop more often than canonical
        const idx = positions[k]!;
        cursor.set(row.stopId, k + 1);
        // The occurrence slot is consumed regardless, but only a SERVED row
        // writes a departure — a present-but-not-served row leaves the slot's
        // sentinel so repeats downstream stay aligned (mirrors index.rs).
        if (row.depSecs !== MISSING_DEP_SENTINEL) {
          departureSecs[idx] = row.depSecs;
        }
        if (row.arrDiff < 0) {
          // arrDiff = arrival - departure; positive dwell ⇒ arrDiff is negative
          // (arrival is earlier than departure). Convert to absolute dwell secs.
          const dwell = -row.arrDiff;
          if (dwell > 0) {
            if (!dwellSecs) dwellSecs = new Uint16Array(stopIds.length);
            dwellSecs[idx] = dwell > 0xffff ? 0xffff : dwell;
          }
        }
        if (row.pickupType !== 0) {
          (pickupTypes ??= new Uint8Array(stopIds.length))[idx] = row.pickupType;
        }
        if (row.dropOffType !== 0) {
          (dropOffTypes ??= new Uint8Array(stopIds.length))[idx] = row.dropOffType;
        }
      }
      tripsOut.push({
        tripId: trip.tripId,
        serviceId: trip.serviceId,
        headsign: trip.headsign,
        departureSecs,
        ...(dwellSecs ? { dwellSecs } : {}),
        ...(pickupTypes ? { pickupTypes } : {}),
        ...(dropOffTypes ? { dropOffTypes } : {}),
      });
    }

    tripsOut.sort((a, b) => {
      const a0 = a.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : a.departureSecs[0]!;
      const b0 = b.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : b.departureSecs[0]!;
      return a0 - b0;
    });

    // The PTB carries direction_id per trip (forwarded via GtfsTrip.directionId).
    // Mirror index-builder's composite-key bucketing: `${directionId}:${headsign}`
    // when direction_id is present, `${headsign}` otherwise. This matches
    // index-builder.ts:261-262 for the bucketing logic, so directionPatterns
    // correctly separate genuinely opposite directions even when they share a
    // headsign. Note: the diagnostic `key` field on RouteDirectionPattern is set
    // to compositeKey here vs. index-builder's `directionKey` (which falls back to
    // headsign when directionId is absent) — harmless because consumers key off
    // stopIds/headsign, not this field.
    const directionGroups = new Map<string, { headsign: string; tripIdxs: number[] }>();
    for (const ti of bucket.tripIdxs) {
      const trip = trips[ti]!;
      const directionKey = trip.directionId !== undefined ? String(trip.directionId) : "";
      const compositeKey = directionKey === "" ? trip.headsign : `${directionKey}:${trip.headsign}`;
      let g = directionGroups.get(compositeKey);
      if (!g) { g = { headsign: trip.headsign, tripIdxs: [] }; directionGroups.set(compositeKey, g); }
      g.tripIdxs.push(ti);
    }
    const directionPatterns: RouteDirectionPattern[] = [];
    for (const [compositeKey, group] of directionGroups) {
      let bestTi = group.tripIdxs[0]!;
      let bestLen = tripStopSeqs[bestTi]?.length ?? 0;
      for (let i = 1; i < group.tripIdxs.length; i++) {
        const len = tripStopSeqs[group.tripIdxs[i]!]?.length ?? 0;
        if (len > bestLen) { bestLen = len; bestTi = group.tripIdxs[i]!; }
      }
      const seqs = tripStopSeqs[bestTi];
      if (!seqs || seqs.length === 0) continue;
      const sorted = [...seqs].sort((a, b) => a.stopSeq - b.stopSeq);
      directionPatterns.push({ key: compositeKey, headsign: group.headsign, stopIds: sorted.map((r) => r.stopId) });
    }

    if (!patternsEnabled(mode)) {
      // Off (legacy): emit the single canonical record, byte-identical to pre-pattern.
      // Shallow-copy directionPatterns so the caller holds an independent record.
      routeTrips.push({ routeId, stopIds, trips: tripsOut, directionPatterns: directionPatterns.map((p) => ({ ...p })) });
    } else {
      // Unbounded: group trips by their RAW stop-index signature (each trip's own
      // served stop sequence in stop_seq order, repeats preserved, including
      // MISSING_DEP_SENTINEL rows) and emit one RouteTripsData per pattern (repeated
      // routeId). Mirrors ptbToBundleWire.ts's Unbounded branch exactly so both
      // paths produce the same pattern split for a given PTB — the differential gate
      // and the PTB boot path are aligned. Branch stops not in the longest trip's
      // canonical ARE covered here because we use raw PTB stop indices as the pattern
      // canonical, not canonical-aligned positions.
      //
      // Per-trip raw stop-index sequences: sorted by stop_seq, ALL rows included
      // (even MISSING_DEP_SENTINEL, and even a row whose stop is missing from
      // ptnb.stops — that surfaces as a loud RangeError in the patternStopIds map
      // below, matching ptbToBundleWire and the pre-refactor behaviour). Re-sliced
      // straight from ptnb.stopTimes (still alive — loadFromPtb only nulls it AFTER
      // this function returns) rather than from the removed `groupedRows`. Scoped to
      // THIS route's trips, so the total work is O(stop_times), not O(routes × trips).
      const rawSeqByTripIdx = new Map<number, number[]>(); // tripIdx → raw stopIdx[]
      const boardingByTripIdx = new Map<number, number[]>();
      for (const ti of bucket.tripIdxs) {
        const lo = ptnb.tripStarts[ti]!;
        const hi = ptnb.tripStarts[ti + 1]!;
        const rows = ptnb.stopTimes.slice(lo, hi).map((row, i) => ({
          row, boarding: (ptnb.boarding?.[lo + i] ?? 0x50) & 0x0f,
        }));
        rows.sort((a, b) => a.row.stopSeq - b.row.stopSeq);
        rawSeqByTripIdx.set(ti, rows.map((r) => r.row.stopIdx));
        boardingByTripIdx.set(ti, rows.map((r) => r.boarding));
      }

      const tripForGrouping = bucket.tripIdxs.map((ti, localIdx) => ({
        tripIdx: localIdx,
        stopIdxs: rawSeqByTripIdx.get(ti) ?? [],
        boarding: boardingByTripIdx.get(ti) ?? [],
      }));

      const patternGroups = groupTripsByPattern(tripForGrouping, mode);
      for (const pg of patternGroups) {
        // Pattern canonical: the raw PTB stop indices from the signature. Map to
        // stopId strings via ptnb.stops. Handles stops not in the longest-trip
        // canonical (branch stops, e.g. s4 in a branch variant).
        const patternStopIds = pg.stopIdxs.map((idx) => {
          const s = ptnb.stops[idx];
          if (!s) throw new RangeError(`loadFromPtb Unbounded: stopIdx=${idx} out of range`);
          return s.stopId;
        });

        // Re-align each pattern member's departureSecs against this pattern's
        // canonical stop sequence. NATIVE members (offset 0 — every member under
        // Unbounded) use the lasso/loop-safe from-position-0 occurrence cursor.
        // FOLDED members (CoveringMerge, offset > 0) MUST be placed POSITIONALLY:
        // row i lands at pattern position offset+i, mirroring
        // ptbBundleToWire.ts::emitWireRoute and the Rust index.rs byte-for-byte.
        // A from-position-0 cursor would re-seek a folded trip's rows to the
        // FIRST occurrence of each stop and mis-place them whenever the covering
        // pattern repeats a stop (loop/lasso) — the exact bug the positional
        // branch guards against (`covering_merge_offset_window_beats_cursor_on_repeat`).
        const patStopIdToPositions = new Map<string, number[]>();
        patternStopIds.forEach((s, i) => {
          let positions = patStopIdToPositions.get(s);
          if (!positions) { positions = []; patStopIdToPositions.set(s, positions); }
          positions.push(i);
        });

        const alignedTrips: RouteTripEntryLike[] = pg.tripIdxs.map((localIdx, mi) => {
          const ti = bucket.tripIdxs[localIdx]!;
          const trip = trips[ti]!;
          const offset = pg.offsets[mi]!;
          const patDeps = new Uint32Array(patternStopIds.length).fill(UNSERVED_STOP_SENTINEL);
          let patDwell: Uint16Array | undefined;
          // Parallel to patDwell: pickup/drop_off types aligned to this pattern's
          // canonical, lazy-alloc, omitted when all-default 0.
          let patPickup: Uint8Array | undefined;
          let patDropOff: Uint8Array | undefined;
          const rows = [...tripStopSeqs[ti]!].sort((a, b) => a.stopSeq - b.stopSeq);

          if (offset > 0) {
            // Folded member: this shorter trip rides the longer covering pattern
            // at window [offset, offset+rows.length). Its own stop sequence IS
            // patternStopIds[offset .. offset+rows.length] by the fold predicate
            // (contiguous subsequence), so place row i at position offset+i.
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i]!;
              const idx = offset + i;
              if (row.depSecs !== MISSING_DEP_SENTINEL) {
                patDeps[idx] = row.depSecs;
              }
              if (row.arrDiff < 0) {
                const dwell = -row.arrDiff;
                if (dwell > 0) {
                  if (!patDwell) patDwell = new Uint16Array(patternStopIds.length);
                  patDwell[idx] = dwell > 0xffff ? 0xffff : dwell;
                }
              }
              if (row.pickupType !== 0) {
                (patPickup ??= new Uint8Array(patternStopIds.length))[idx] = row.pickupType;
              }
              if (row.dropOffType !== 0) {
                (patDropOff ??= new Uint8Array(patternStopIds.length))[idx] = row.dropOffType;
              }
            }
          } else {
            const cursor = new Map<string, number>();
            for (const row of rows) {
              const positions = patStopIdToPositions.get(row.stopId);
              if (positions === undefined) continue;
              const k = cursor.get(row.stopId) ?? 0;
              if (k >= positions.length) continue;
              const idx = positions[k]!;
              cursor.set(row.stopId, k + 1);
              if (row.depSecs !== MISSING_DEP_SENTINEL) {
                patDeps[idx] = row.depSecs;
              }
              if (row.arrDiff < 0) {
                const dwell = -row.arrDiff;
                if (dwell > 0) {
                  if (!patDwell) patDwell = new Uint16Array(patternStopIds.length);
                  patDwell[idx] = dwell > 0xffff ? 0xffff : dwell;
                }
              }
              if (row.pickupType !== 0) {
                (patPickup ??= new Uint8Array(patternStopIds.length))[idx] = row.pickupType;
              }
              if (row.dropOffType !== 0) {
                (patDropOff ??= new Uint8Array(patternStopIds.length))[idx] = row.dropOffType;
              }
            }
          }
          return {
            tripId: trip.tripId,
            serviceId: trip.serviceId,
            headsign: trip.headsign,
            departureSecs: patDeps,
            ...(patDwell ? { dwellSecs: patDwell } : {}),
            ...(patPickup ? { pickupTypes: patPickup } : {}),
            ...(patDropOff ? { dropOffTypes: patDropOff } : {}),
          };
        });

        // Keep trips sorted by first departure within the pattern.
        alignedTrips.sort((a, b) => {
          const a0 = a.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : a.departureSecs[0]!;
          const b0 = b.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : b.departureSecs[0]!;
          return a0 - b0;
        });

        // Shallow-copy directionPatterns per record so patterns sharing the
        // same route don't alias the same array reference.
        const dp = directionPatterns.map((p) => ({ ...p }));
        routeTrips.push({ routeId, stopIds: patternStopIds, trips: alignedTrips, directionPatterns: dp });
      }
    }
  }

  return { stopTimesIndex, stopRouteTripCounts, routeTrips };
}

// ── Identity: real bitmasks from PTB, synthesised id tables ──────────────

function buildPtbIdentity(
  ptnb: PtbBundle,
  stops: GtfsStop[],
  routes: GtfsRoute[],
  trips: GtfsTrip[],
  services: GtfsService[],
  tripStrings: TripStringTable,
  feedStartDate: string,
): Identity {
  const stopsTable = staticInternTable(stops.map((s) => s.id));
  const routesTable = staticInternTable(routes.map((r) => r.id));
  const servicesTable = staticInternTable(services.map((s) => s.serviceId));
  const headsignsTable = staticInternTable([...new Set(trips.map((t) => t.headsign))]);

  // PTB bitmask region: numServices × bytesPerService(windowDays) bytes (stride
  // = ceil(windowDays/8); 12 at the 90-day default, 50 at 400). Anchor day-0 of
  // the bitmask window is the producer's feed_start_date read from the bundle header
  // (converted via feedStartDateIso). Using Node's process-start day instead
  // would shift every weekday bit by (now - feedStartDate) days. The per-service
  // horizon is the runtime windowDays so a longer window is reported honestly.
  const buildDateIso = feedStartDate;
  const bitmasks = new Map<string, ServiceBitmask>();
  const bytesPer = bytesPerService(ptnb.windowDays);
  for (let i = 0; i < ptnb.numServices; i++) {
    const start = i * bytesPer;
    const slice = ptnb.serviceBitmasks.slice(start, start + bytesPer);
    bitmasks.set(serviceIdFor(i), {
      startDateIso: buildDateIso,
      horizonDays: ptnb.windowDays,
      bits: slice,
    });
  }

  return {
    stops: stopsTable,
    routes: routesTable,
    services: servicesTable,
    headsigns: headsignsTable,
    trips: {
      get size(): number { return tripStrings.size; },
      indexOf: (s: string) => tripStrings.indexOf(s),
      valueAt: (ix: number) => tripStrings.stringAt(ix),
    },
    bitmasks,
    buildDateIso,
    horizonDays: ptnb.windowDays,
  };
}

function staticInternTable(values: string[]): InternTable<string> {
  const arr = values.slice();
  const map = new Map<string, number>();
  for (let i = 0; i < arr.length; i++) map.set(arr[i]!, i);
  return {
    get size(): number { return arr.length; },
    indexOf: (v: string) => map.get(v) ?? -1,
    valueAt: (ix: number): string => {
      if (!Number.isInteger(ix) || ix < 0 || ix >= arr.length) {
        throw new RangeError(`InternTable: ix ${ix} out of range (size=${arr.length})`);
      }
      return arr[ix]!;
    },
  };
}

// ── Shapes from sidecar ───────────────────────────────────────────────────

function sidecarShapesToPoints(groups: ShapeGroup[]): GtfsShapePoint[] {
  const out: GtfsShapePoint[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.points.length; i++) {
      const p = g.points[i]!;
      out.push({ shapeId: g.shapeId, lat: p.lat, lon: p.lon, sequence: i + 1 });
    }
  }
  return out;
}

function buildShapesFromSidecar(
  shapePoints: GtfsShapePoint[],
  groups: ShapeGroup[],
  caps: ReturnType<typeof readCaps>,
): { shapes: RoutingBundleShape[]; droppedShapes: number } {
  // The PTB carries per-trip shapeId, but shape-ref counting still uses the
  // sidecar `tripRefCount` — re-deriving per-shape trip counts from per-trip
  // shapeId is deferred to Phase C. Feed `tripRefCount` through so
  // orphan-filtering, cap-eviction order, and output ordering match the Node
  // path exactly (an earlier stub used one synthetic trip per shape — that
  // forced every shape to refs===1, diverging on all three). Phase C folds
  // shape_ids into the PTB header and retires the sidecar.
  const tripShapeRefs = new Map<string, number>();
  for (const g of groups) tripShapeRefs.set(g.shapeId, g.tripRefCount);
  const { shapes, droppedCount } = buildShapesIndex({
    shapePoints,
    trips: [],
    tripShapeRefs,
    caps: {
      shapesCount: caps.shapesCount,
      pointsPerShape: caps.pointsPerShape,
      shapesEncodedBytes: caps.shapesEncodedBytes,
    },
  });
  return { shapes, droppedShapes: droppedCount };
}

// Suppress unused-export lint — these types are used internally for clarity.
export type { GtfsIndexes, RoutingBuildInput, CanonicalStore };
