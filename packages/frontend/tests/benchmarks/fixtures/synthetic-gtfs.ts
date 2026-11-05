/**
 * Deterministic synthetic GTFS fixture for performance benchmarks.
 *
 * Produces records that satisfy the IndexedDB table types exported from
 * `src/db/index.ts`. Importing the real types means schema drift is caught
 * by the compiler.
 *
 * Default scale targets a mid-sized European transit network, somewhat
 * inflated over real Gdansk ZTM (~100 routes) for stress-test headroom.
 *
 * Output is fully deterministic for a given seed — benchmarks can rely on
 * the same data across runs for stable comparisons.
 */

import type {
  GtfsStopRecord,
  GtfsRouteRecord,
  GtfsTripRecord,
  GtfsServiceRecord,
} from "../../../src/db/index.ts";
import type { RaptorBundleWire } from "../../../src/services/gtfsBundle.ts";
import { PatternMode, patternsEnabled } from "@pt/shared";

/** Seeded mulberry32 RNG — deterministic across runs and platforms. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticScale {
  stops: number;
  routes: number;
  tripsPerRoute: number;
  stopsPerRoute: number;
  /**
   * Distinct served-stop-index VARIANTS each route emits (default 1 = today's
   * single-pattern behaviour, fully backward-compatible). When `> 1`, the
   * route's trips are partitioned across `patternsPerRoute` variants, each
   * dropping a DIFFERENT interior stop from the route's full sequence so the
   * variants have genuinely different pattern signatures. The legacy Dexie
   * tables can't represent this (PK=route_id can't hold same-id variants), so
   * the multi-variant fan-out is observable ONLY through `syntheticToBundleWire`
   * (one wire-route per variant) fed to `hydrate(..., Unbounded)`. Under
   * `PatternMode.Off` every variant collapses back to one canonical route, so
   * grouping is a no-op and `patternsPerRoute` has no effect — exactly the
   * legacy single-pattern bench.
   */
  patternsPerRoute?: number;
}

/** Approximate Gdansk ZTM scale (single-pattern — `patternsPerRoute` defaults to 1). */
export const GDANSK_SCALE: SyntheticScale = {
  stops: 2000,
  routes: 200,
  tripsPerRoute: 40,
  stopsPerRoute: 30,
};

/**
 * Pattern-sensitive scale for the patterns-ON SCAN-delta bench.
 *
 * Sizing rationale (keep the bench seconds, not minutes, while making the CSR
 * fan-out visible):
 *  - `routes`/`tripsPerRoute`/`stopsPerRoute` mirror GDANSK_SCALE so the
 *    single-pattern cost is comparable and the delta is attributable to the
 *    pattern fan-out alone, not a larger network.
 *  - `patternsPerRoute: 4` makes the Unbounded `routesAtStop`/`patternsAtStop`
 *    CSR fan out to ~4× the GTFS-route count of pattern-routes (200 routes →
 *    ~800 pattern-routes), so each RAPTOR round scans ~4× more route objects —
 *    this is the SCAN regression the bench must surface.
 *  - `tripsPerRoute: 40` / 4 variants = 10 trips per variant — enough trips per
 *    pattern that each pattern-route still carries a real trip list (an empty
 *    pattern-route would be elided and understate the fan-out).
 */
export const PATTERN_FANOUT_SCALE: SyntheticScale = {
  stops: 2000,
  routes: 200,
  tripsPerRoute: 40,
  stopsPerRoute: 30,
  patternsPerRoute: 4,
};

/**
 * One served-stop-index VARIANT of a route plus the trips assigned to it. The
 * legacy Dexie tables (`routes`/`trips`) can't represent multiple same-id
 * variants, so this parallel structure carries the per-variant stop sequences
 * that `syntheticToBundleWire` turns into one wire-route per variant. When
 * `patternsPerRoute === 1` every route has exactly one variant equal to its
 * full `stopIds` — identical to the legacy single-pattern fixture.
 */
export interface SyntheticPatternVariant {
  /** The variant's own stop_id sequence (a subsequence of the route's stops). */
  readonly stopIds: readonly string[];
  /** tripIds assigned to this variant (a partition of the route's trips). */
  readonly tripIds: readonly string[];
}

export interface SyntheticRoutePatterns {
  readonly routeId: string;
  readonly shortName: string;
  readonly variants: readonly SyntheticPatternVariant[];
}

export interface SyntheticGtfs {
  readonly stops: readonly GtfsStopRecord[];
  readonly routes: readonly GtfsRouteRecord[];
  readonly trips: readonly GtfsTripRecord[];
  readonly services: readonly GtfsServiceRecord[];
  readonly serviceId: string;
  /**
   * Per-route served-stop-index variants (one per route). With
   * `patternsPerRoute === 1` each route has a single variant = its full
   * `stopIds`; with `> 1` each route fans out into `patternsPerRoute` distinct
   * variants. Consumed by `syntheticToBundleWire` to drive the patterns-ON
   * (`PatternMode.Unbounded`) scan path. The legacy `trips[]` keep the full
   * route sequence for the Dexie/Off path, so seeding Dexie stays unchanged.
   */
  readonly routePatterns: readonly SyntheticRoutePatterns[];
}

export function generateSyntheticGtfs(
  scale: SyntheticScale = GDANSK_SCALE,
  seed: number = 42,
): SyntheticGtfs {
  if (!Number.isInteger(scale.stops) || scale.stops <= 0) {
    throw new Error(`generateSyntheticGtfs: stops must be a positive integer (got ${scale.stops})`);
  }
  if (!Number.isInteger(scale.routes) || scale.routes < 0) {
    throw new Error(`generateSyntheticGtfs: routes must be a non-negative integer (got ${scale.routes})`);
  }
  if (!Number.isInteger(scale.tripsPerRoute) || scale.tripsPerRoute < 0) {
    throw new Error(`generateSyntheticGtfs: tripsPerRoute must be a non-negative integer (got ${scale.tripsPerRoute})`);
  }
  if (!Number.isInteger(scale.stopsPerRoute) || scale.stopsPerRoute < 0) {
    throw new Error(`generateSyntheticGtfs: stopsPerRoute must be a non-negative integer (got ${scale.stopsPerRoute})`);
  }
  if (scale.stopsPerRoute > scale.stops) {
    throw new Error(
      `generateSyntheticGtfs: stopsPerRoute (${scale.stopsPerRoute}) must not exceed stops (${scale.stops}) — would hang`,
    );
  }
  if (scale.tripsPerRoute > 0 && scale.stopsPerRoute === 0) {
    throw new Error(
      `generateSyntheticGtfs: tripsPerRoute=${scale.tripsPerRoute} requires stopsPerRoute > 0 (trips would have empty departureSecs, silently producing useless benchmark data)`,
    );
  }
  const patternsPerRoute = scale.patternsPerRoute ?? 1;
  if (!Number.isInteger(patternsPerRoute) || patternsPerRoute <= 0) {
    throw new Error(
      `generateSyntheticGtfs: patternsPerRoute must be a positive integer (got ${scale.patternsPerRoute})`,
    );
  }
  if (patternsPerRoute > 1 && scale.tripsPerRoute < patternsPerRoute) {
    throw new Error(
      `generateSyntheticGtfs: tripsPerRoute (${scale.tripsPerRoute}) must be >= patternsPerRoute (${patternsPerRoute}) — otherwise some variants get zero trips and the fan-out is silently understated`,
    );
  }
  // Each variant v drops the interior stop at position 1+v from the full
  // sequence (endpoints kept so every variant is still a valid line). That
  // needs at least `patternsPerRoute` interior positions, i.e.
  // stopsPerRoute >= patternsPerRoute + 2 (2 endpoints + N droppable interiors).
  if (patternsPerRoute > 1 && scale.stopsPerRoute < patternsPerRoute + 2) {
    throw new Error(
      `generateSyntheticGtfs: stopsPerRoute (${scale.stopsPerRoute}) must be >= patternsPerRoute + 2 (${patternsPerRoute + 2}) so each variant can drop a distinct interior stop`,
    );
  }

  const rand = rng(seed);
  const serviceId = "sv_all";

  // Bounding box: lat [54.3, 54.5) × lon [18.5, 18.8). At 54°N after cos(lat)
  // correction this is ~22km N-S × ~19km E-W. Gdansk city center (~54.35,
  // ~18.65) sits near the south edge, not centered — a stress-test layout,
  // not a realistic map.
  const stops: GtfsStopRecord[] = Array.from({ length: scale.stops }, (_, i) => ({
    id: `s${i}`,
    name: `Stop ${i}`,
    lat: 54.3 + rand() * 0.2,
    lon: 18.5 + rand() * 0.3,
    wheelchairBoarding: rand() > 0.3 ? 1 : 0,
  }));

  const routes: GtfsRouteRecord[] = [];
  const trips: GtfsTripRecord[] = [];
  const routePatterns: SyntheticRoutePatterns[] = [];

  for (let r = 0; r < scale.routes; r++) {
    // Pick N unique stop indices for this route
    const stopIds: string[] = [];
    const used = new Set<number>();
    while (stopIds.length < scale.stopsPerRoute) {
      const idx = Math.floor(rand() * scale.stops);
      if (!used.has(idx)) {
        used.add(idx);
        stopIds.push(`s${idx}`);
      }
    }

    routes.push({
      id: `r${r}`,
      shortName: `R${r}`,
      mode: "BUS",
      stopIds,
    });

    // Variant v serves the full sequence MINUS the interior stop at position
    // 1+v. With patternsPerRoute=1 the "drop position" loop runs once with no
    // drop → variant === full sequence (legacy single-pattern). With >1 the
    // variants have genuinely distinct signatures, so `groupTripsByPattern`
    // (Unbounded) emits one pattern-route per variant — a real ~Nx CSR fan-out.
    const variantStopIds: string[][] = [];
    for (let v = 0; v < patternsPerRoute; v++) {
      if (patternsPerRoute === 1) {
        variantStopIds.push(stopIds.slice());
      } else {
        const dropPos = 1 + v; // interior; endpoints (0, last) always kept
        variantStopIds.push(stopIds.filter((_, i) => i !== dropPos));
      }
    }
    const variantTripIds: string[][] = variantStopIds.map(() => []);

    for (let t = 0; t < scale.tripsPerRoute; t++) {
      // Round-robin trips across variants so every variant gets a near-equal
      // share (deterministic — no RNG, so the partition is stable across runs).
      const v = t % patternsPerRoute;
      const seq = variantStopIds[v]!;
      const tripId = `t_${r}_${t}`;
      // Trip start uniformly in [5:00, 23:00); 60s between consecutive stops
      // (so a trip spans (seq.length - 1) minutes).
      const start = 5 * 3600 + Math.floor(rand() * 18 * 3600);
      // Legacy Dexie/Off path: departureSecs aligned to the FULL route stopIds
      // (single canonical pattern). The wire path re-derives per-variant
      // departures from `seq` in syntheticToBundleWire — Dexie never sees the
      // variant fan-out (it can't; PK=route_id).
      const departureSecs = stopIds.map((_, i) => start + i * 60);
      trips.push({
        tripId,
        routeId: `r${r}`,
        serviceId,
        headsign: `To end of R${r}`,
        departureSecs,
      });
      variantTripIds[v]!.push(tripId);
    }

    routePatterns.push({
      routeId: `r${r}`,
      shortName: `R${r}`,
      variants: variantStopIds.map((seq, v) => ({
        stopIds: seq,
        tripIds: variantTripIds[v]!,
      })),
    });
  }

  const services: GtfsServiceRecord[] = [{
    serviceId,
    days: [true, true, true, true, true, true, true],
    startDate: "20260101",
    endDate: "20271231",
    exceptions: {},
  }];

  return { stops, routes, trips, services, serviceId, routePatterns };
}

/**
 * Project a `SyntheticGtfs` into a `RaptorBundleWire` with ONE wire-route per
 * served-stop-index variant. This mirrors `ptbBundleToWire`'s per-route wire shape: under
 * `PatternMode.Unbounded` a route's `patternsPerRoute` variants each become a
 * separate wire-route SHARING the bare `route_id`, so `rawFromBundle` +
 * `hydrate(..., Unbounded)` build a `patterns[]`/`patternsAtStop` CSR that fans
 * out past the GTFS-route count — exactly the SCAN-delta vehicle the bench
 * needs. The Dexie path can't express this (PK=route_id), so the wire is the
 * only seam that exercises the patterns-ON code path.
 *
 * Chosen over the "construct a `patterns[]`-bearing RaptorIndex directly"
 * option because the wire path runs the REAL production `hydrate` grouping/CSR
 * code (`buildPatternAtStop`, `aggregateDisplay`) — so the bench measures the
 * shipped index-build + scan, not a hand-rolled index that could drift from it.
 *
 * @param gtfs
 * - Output of `generateSyntheticGtfs`.
 * @param mode
 * - When `Off`, emits one wire-route per route using the full
 *   `stopIds` (single-pattern, identical to the Dexie/legacy path). When
 *   `Unbounded`/`CoveringMerge`, emits one wire-route per variant.
 */
export function syntheticToBundleWire(
  gtfs: SyntheticGtfs,
  mode: PatternMode = PatternMode.Off,
): RaptorBundleWire {
  // departureSecs per variant: re-derive from the variant's own (shorter) stop
  // sequence so each pattern-route's trips align to ITS positions. Reuse the
  // deterministic start each trip already carries on the Dexie record (its
  // departureSecs[0]) so the wire stays reproducible from the same seed.
  const startById = new Map<string, number>();
  for (const t of gtfs.trips) startById.set(t.tripId, t.departureSecs[0]!);

  const wireRoutes: RaptorBundleWire["routes"] = [];
  for (const rp of gtfs.routePatterns) {
    const emit = (stopIds: readonly string[], tripIds: readonly string[]): void => {
      wireRoutes.push({
        id: rp.routeId, // bare route_id, repeated across variants
        shortName: rp.shortName,
        mode: "BUS",
        stopIds: [...stopIds],
        trips: tripIds.map((tripId) => {
          const start = startById.get(tripId) ?? 5 * 3600;
          return {
            tripId,
            serviceId: gtfs.serviceId,
            headsign: `To end of ${rp.shortName}`,
            departureSecs: stopIds.map((_, i) => start + i * 60),
          };
        }),
      });
    };
    if (patternsEnabled(mode)) {
      for (const v of rp.variants) emit(v.stopIds, v.tripIds);
    } else {
      // Off: collapse all variants into one wire-route carrying every trip, over
      // the longest variant's stop sequence. With patternsPerRoute=1 that is the
      // route's full sequence; with >1 all variants are equal length so this is
      // just variant 0 (NOT a true stop-union — the bench only exercises the
      // Unbounded branch, so an exact Off canonical isn't needed here). Mirrors
      // the Dexie/Off single-pattern shape closely enough for the fixture.
      const allTripIds = rp.variants.flatMap((v) => [...v.tripIds]);
      let longest = rp.variants[0]!.stopIds;
      for (const v of rp.variants) if (v.stopIds.length > longest.length) longest = v.stopIds;
      emit(longest, allTripIds);
    }
  }

  return {
    version: 12,
    meta: { generatedAt: new Date(0).toISOString() },
    routes: wireRoutes,
    calendar: gtfs.services.map((s) => ({
      serviceId: s.serviceId,
      days: s.days,
      startDate: s.startDate,
      endDate: s.endDate,
      exceptions: s.exceptions,
    })),
    stops: gtfs.stops.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      ...(s.wheelchairBoarding !== undefined ? { wheelchairBoarding: s.wheelchairBoarding } : {}),
    })),
  };
}
