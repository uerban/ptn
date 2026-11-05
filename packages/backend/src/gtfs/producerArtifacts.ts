import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Per-generation producer-artifact loader (C4 Stage 1, I-1/I-6).
 *
 * In `PT_SCHEDULE_TILE_SOURCE=producer` mode the producer build emits two
 * per-generation JSON artifacts into the generation ROOT (`<gen>/`):
 *   - `trip-route.json`: interned `{routes: string[], trips: {tripId: routeIdx}}`
 *     so `/api/rt/:routeId` can group RT by route WITHOUT the resident GTFS index.
 *   - `stop-cell.json`: `{stopId: tileCoords}` (the exact on-disk `.br` filename
 *     stem) so a departures reader picks a stop's owning tile WITHOUT reading the
 *     canonical store's lat/lon geometry. NOTE: that reader (`/api/departures`)
 *     was deleted on 2026-08-10, so this half of the loader currently has no
 *     production consumer — see `gtfs/producerDepartures.ts`. It is still loaded
 *     and still reported by `/health/ready`.
 *
 * This module is the read side. Like `ProducerScheduleTileSource`, the resolved
 * generation is RE-RESOLVED per call (the producer publishes new generations and
 * pt-serve self-reloads, so the gen dir changes under the backend), but the
 * parsed maps + verified SHAs are CACHED keyed on the `generationId` STRING — NOT
 * on `(mtime,size)` (the constant-size-file collision lesson from
 * `producerScheduleTiles.ts`). We re-read / re-hash / re-parse only on a
 * generation roll; eviction keeps the last 1.
 *
 * I-1: the `generationId`, gen dir, and expected SHAs come from ONE
 * `readGeneration()` resolution (a single `current.json` + `generation.json`
 * read), so each `current()` does one cheap pointer read on a cache hit, never
 * three. B2: the `/api/rt` hot path uses `routeLookup()` to resolve `current()`
 * ONCE per request and run a pure closure per trip — no per-trip `readFileSync`.
 *

 * * The single `readGeneration` resolver is INJECTED (`index.ts` derives it off the same
 * `current.json`/`generation.json` resolution the schedule-tile source already does), so this
 * file holds NO `GtfsStore`/`canonical` reference — the C4-survivable seam.

 *

 * * SHA-mismatch, parse failure, or absent file ⇒ that map is treated as artifact-ABSENT (the
 * consumer falls through to the legacy `canonical` path and counts a fallback — see
 * Observability).
 */

const TRIP_ROUTE_FILE = "trip-route.json";
const STOP_CELL_FILE = "stop-cell.json";

/** Interned trip→route wire shape (`schedule-tile-gen.mjs` emits this). */
interface TripRouteWire {
  routes: string[];
  trips: Record<string, number>;
}

/**
 * Loaded trip→route representation. I-2: the on-wire `trips: Record<string,
 * number>` is converted to a real `Map<string, number>` at load. A `Map` is the
 * better footprint AND lookup at the ~473k-entry Paris/IDFM scale than a plain
 * object with that many string keys (V8 megamorphic-dictionary mode), and the
 * route is still held as an index resolved via the tiny `routes[]` array (NOT a
 * `Map<string,string>` that would duplicate every route string per trip).
 */
interface LoadedTripRoute {
  routes: string[];
  trips: Map<string, number>;
}

/** Stop→tileCoords wire shape (`{stopId: "x_y"|"x_y-suffix"}`). */
type StopCellWire = Record<string, string>;
/** Loaded stop→tileCoords representation — a `Map` for the same footprint reason. */
type LoadedStopCell = Map<string, string>;

/** The two expected SHA-256 hex digests recorded in `generation.json`. */
export interface ProducerArtifactShas {
  tripRoute?: string;
  stopCell?: string;
}

/**
 * One resolution of the currently-published generation, from a SINGLE
 * `current.json` read (+ a single `generation.json` read for the SHAs). I-1:
 * collapsing `generationId`, the gen dir, and the expected SHAs into ONE read
 * closes both the three redundant `current.json` reads the old three-thunk shape
 * incurred per resolution AND the cross-seam tear (three independent reads could
 * straddle a mid-publish `current.json` rewrite).
 */
export interface ResolvedGeneration {
  /** The cache key — a change re-reads the artifact bodies; unchanged is a hit. */
  generationId: string;
  /**
   * The generation ROOT dir (`<dataRoot>/generations/<generationId>`) — the
   * PARENT of `tileSource.resolveDataDir()`'s `schedule-tiles`.
   */
  dir: string;
  /**
   * The expected SHA-256 hex digests from `generation.json`
   * (`tripRouteSha256`/`stopCellSha256`). An absent SHA ⇒ that artifact was not
   * emitted ⇒ treated as absent (no read attempted, no fallback warn).
   */
  shas: ProducerArtifactShas;
}

export interface ProducerArtifactsDeps {
  /**
   * Resolve the currently-published generation from ONE `current.json` read (+
   * one `generation.json` read). `null` ⇒ unresolved (cold start / mid-publish /
   * malformed) ⇒ no maps. Called once per `current()` resolution; on a cache hit
   * (the returned `generationId` matches the cached one) the artifact bodies are
   * NOT re-read.
   */
  readGeneration: () => ResolvedGeneration | null;
  /**
   * Optional logger (fastify pino `log.warn(obj, msg)`). Receives a `warn` only
   * when a present-and-expected artifact fails to read/parse/verify for a
   * non-ENOENT reason. A bare ENOENT (artifact never emitted / janitor race)
   * stays quiet — the absence is signalled via `artifactsPresent()` and the
   * fallback counter, not a log line.
   */
  log?: { warn: (obj: object, msg: string) => void };
}

export interface ProducerArtifacts {
  /** Resolve a trip's route id, or `undefined` for an unknown/absent-map trip. */
  routeForTrip(tripId: string): string | undefined;
  /**
   * Resolve the generation ONCE and return a pure in-memory trip→route lookup
   * (B2). The `/api/rt` hot path calls this once per request and runs the
   * returned closure per RT trip — so the per-resolution `current.json` read
   * happens at most once per request, never once per trip. An absent/unreadable
   * `trip-route.json` returns a `() => undefined` lookup.
   */
  routeLookup(): (tripId: string) => string | undefined;
  /** Resolve a stop's on-disk tileCoords, or `undefined` for an unknown/absent stop. */
  tileCoordsForStop(stopId: string): string | undefined;
  /** Presence of each loaded map (for `/health/ready` + metrics). */
  artifactsPresent(): { tripRoute: boolean; stopCell: boolean };
  /** The verified SHAs of the loaded maps (for `/health/ready`). */
  loadedShas(): { tripRoute?: string; stopCell?: string };
  /**
   * The currently-loaded `generationId` (the cache key), or `null` when nothing
   * is loaded (cold start / mid-publish). For `/health/ready` prod diagnosis over
   * plain HTTP — confirms WHICH generation the artifacts came from.
   */
  loadedGenerationId(): string | null;
}

interface LoadedGeneration {
  generationId: string;
  /** Built from `trip-route.json` (`routes[trips.get(tripId)]`), or `undefined`. */
  tripRoute: LoadedTripRoute | undefined;
  /** Built from `stop-cell.json` as a `Map`, or `undefined`. */
  stopCell: LoadedStopCell | undefined;
  tripRouteSha?: string;
  stopCellSha?: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read + SHA-verify + parse one artifact. Returns the parsed value on success,
 * `undefined` on absent / unreadable / SHA-mismatch / parse-failure. `expected`
 * absent ⇒ artifact not emitted ⇒ `undefined`, no read, no warn.
 */
function loadVerified<T>(
  path: string,
  expected: string | undefined,
  log: ProducerArtifactsDeps["log"],
): T | undefined {
  if (!expected) return undefined;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log?.warn?.({ err, path }, "producer artifacts: artifact unreadable");
    }
    return undefined;
  }
  if (sha256Hex(bytes) !== expected) {
    log?.warn?.({ path }, "producer artifacts: artifact SHA mismatch");
    return undefined;
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (err) {
    log?.warn?.({ err, path }, "producer artifacts: artifact unparseable");
    return undefined;
  }
}

export function createProducerArtifacts(deps: ProducerArtifactsDeps): ProducerArtifacts {
  const { readGeneration, log } = deps;

  // Last-1 cache keyed on the generationId string.
  let cache: LoadedGeneration | null = null;

  /**
   * Re-resolve to the loaded generation, re-reading the artifact bodies only on
   * a generation roll. ONE `current.json` (+ `generation.json`) read per call
   * (via `readGeneration()`, I-1); on a cache hit the bodies are not re-read.
   */
  function current(): LoadedGeneration | null {
    const resolved = readGeneration();
    if (!resolved) return null;
    const { generationId, dir, shas } = resolved;
    if (cache && cache.generationId === generationId) return cache;

    const tripRouteWire = loadVerified<TripRouteWire>(join(dir, TRIP_ROUTE_FILE), shas.tripRoute, log);
    const stopCellWire = loadVerified<StopCellWire>(join(dir, STOP_CELL_FILE), shas.stopCell, log);

    // I-2: convert the parsed JSON objects to `Map`s at load (better footprint +
    // lookup than 473k-key plain objects). The route is still held as an index
    // into the small `routes[]` array.
    const tripRoute: LoadedTripRoute | undefined =
      tripRouteWire && Array.isArray(tripRouteWire.routes) && tripRouteWire.trips
        ? { routes: tripRouteWire.routes, trips: new Map(Object.entries(tripRouteWire.trips)) }
        : undefined;
    const stopCell: LoadedStopCell | undefined =
      stopCellWire && typeof stopCellWire === "object"
        ? new Map(Object.entries(stopCellWire))
        : undefined;

    cache = {
      generationId,
      tripRoute,
      stopCell,
      tripRouteSha: tripRoute ? shas.tripRoute : undefined,
      stopCellSha: stopCell ? shas.stopCell : undefined,
    };
    return cache;
  }

  /** Pure trip→route lookup over an already-resolved `LoadedTripRoute`. */
  function lookupOver(tr: LoadedTripRoute | undefined): (tripId: string) => string | undefined {
    if (!tr) return () => undefined;
    return (tripId: string): string | undefined => {
      const idx = tr.trips.get(tripId);
      // Guard the index into `routes[]` (defensive vs a torn/hand-edited
      // trip-route.json whose `trips` value points past the `routes` array — the
      // SHA check should already reject that, but an out-of-range index would
      // otherwise read `undefined` silently; make the intent explicit).
      if (idx === undefined || idx < 0 || idx >= tr.routes.length) return undefined;
      return tr.routes[idx];
    };
  }

  function routeForTrip(tripId: string): string | undefined {
    return lookupOver(current()?.tripRoute)(tripId);
  }

  /**
   * B2: resolve the generation ONCE (one `current.json` read) and hand back a
   * pure in-memory closure. The `/api/rt` hot path runs this per RT trip without
   * any per-trip I/O.
   */
  function routeLookup(): (tripId: string) => string | undefined {
    return lookupOver(current()?.tripRoute);
  }

  function tileCoordsForStop(stopId: string): string | undefined {
    return current()?.stopCell?.get(stopId);
  }

  function artifactsPresent(): { tripRoute: boolean; stopCell: boolean } {
    const c = current();
    return { tripRoute: c?.tripRoute !== undefined, stopCell: c?.stopCell !== undefined };
  }

  function loadedShas(): { tripRoute?: string; stopCell?: string } {
    const c = current();
    return { tripRoute: c?.tripRouteSha, stopCell: c?.stopCellSha };
  }

  function loadedGenerationId(): string | null {
    return current()?.generationId ?? null;
  }

  return {
    routeForTrip,
    routeLookup,
    tileCoordsForStop,
    artifactsPresent,
    loadedShas,
    loadedGenerationId,
  };
}
