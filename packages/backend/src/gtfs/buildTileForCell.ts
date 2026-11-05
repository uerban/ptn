import type {
  DecodedScheduleTile,
  CalendarRow,
  RouteRow,
  TileTripRow,
  TileStopColumns,
} from "@pt/shared";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import type { GtfsStop } from "./parser.js";
import type { RouteResolvers } from "./routeResolvers.js";

export interface BuildTileForCellInput extends RouteResolvers {
  canonical: CanonicalStore;
  cellStops: GtfsStop[];
  bundleHash: string;
  cityId: string;
  /** Cell side length in meters (12000 for the launch grid). */
  tileSize: number;
}

/**
 * Build a `DecodedScheduleTile` for one tile cell.
 *
 * Inputs are read-only; outputs are fresh allocations. Calling twice with
 * the same inputs produces structurally identical output (necessary for
 * bundle-hash determinism — though the hash is computed elsewhere from
 * canonical inputs, not the tile bytes).
 *
 * String interning: every user-visible string (tripId, headsign,
 * route shortName, route longName) is NFC-normalised before lookup in the
 * intern map. NFD-encoded names from non-ASCII GTFS feeds (Lithuanian, Polish,
 * Arabic, etc.) collapse with their NFC counterparts so visually-identical
 * strings dedupe correctly on the wire and at render time.
 */
export function buildTileForCell(input: BuildTileForCellInput): DecodedScheduleTile {
  const { canonical, cellStops, bundleHash, cityId, tileSize } = input;

  // ── String intern table (NFC-normalised) ──
  const stringTable: string[] = [];
  const stringIx = new Map<string, number>();
  const internString = (raw: string): number => {
    const s = raw.normalize("NFC");
    let ix = stringIx.get(s);
    if (ix === undefined) {
      ix = stringTable.length;
      stringIx.set(s, ix);
      stringTable.push(s);
    }
    return ix;
  };

  // ── Collect unique trips touching any cell stop ──
  const tripIxByTripId = new Map<string, number>();
  const trips: TileTripRow[] = [];
  const routeIxByRouteId = new Map<string, number>();
  const routes: RouteRow[] = [];
  const serviceIxByServiceId = new Map<string, number>();
  const calendar: CalendarRow[] = [];

  const internRoute = (routeId: string): number => {
    let ix = routeIxByRouteId.get(routeId);
    if (ix !== undefined) return ix;
    const r = canonical.getRoute(routeId);
    if (!r) {
      throw new Error(`buildTileForCell: trip references unknown routeId "${routeId}"`);
    }
    ix = routes.length;
    routeIxByRouteId.set(routeId, ix);
    const subMode = input.resolveRouteSubMode(routeId);
    const overrideColor = input.resolveRouteColor(routeId);
    const color = overrideColor ?? (r.color ? `#${r.color}` : undefined);
    routes.push({
      id: r.id,
      shortName: r.shortName.normalize("NFC"),
      longName: r.longName.normalize("NFC"),
      color,
      mode: r.mode,
      subMode,
    });
    return ix;
  };

  const internService = (serviceId: string): number => {
    let ix = serviceIxByServiceId.get(serviceId);
    if (ix !== undefined) return ix;
    const s = canonical.getService(serviceId);
    if (!s) {
      throw new Error(`buildTileForCell: trip references unknown serviceId "${serviceId}"`);
    }
    ix = calendar.length;
    serviceIxByServiceId.set(serviceId, ix);
    const added: string[] = [];
    const removed: string[] = [];
    for (const [date, type] of s.exceptions) {
      if (type === 1) added.push(date);
      else if (type === 2) removed.push(date);
    }
    calendar.push({
      serviceId: s.serviceId,
      days: [s.monday, s.tuesday, s.wednesday, s.thursday, s.friday, s.saturday, s.sunday] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
      startDate: s.startDate,
      endDate: s.endDate,
      added,
      removed,
    });
    return ix;
  };

  const internTrip = (rawTripId: string): number => {
    // Normalise the cache key to the same form used in the string table.
    // Without this, two stops whose CompactStopTimes entries reference the
    // same trip ID in different Unicode normalisations (NFC vs NFD) would
    // each miss the cache and create a duplicate `TileTripRow` — both rows
    // pointing at the same `tripIdIx` in the (already NFC-deduped) string
    // table.
    const tripId = rawTripId.normalize("NFC");
    let ix = tripIxByTripId.get(tripId);
    if (ix !== undefined) return ix;
    const t = canonical.getTrip(rawTripId);
    if (!t) {
      throw new Error(`buildTileForCell: stop references unknown tripId "${rawTripId}"`);
    }
    ix = trips.length;
    tripIxByTripId.set(tripId, ix);
    trips.push({
      tripIdIx: internString(t.tripId),
      routeIx: internRoute(t.routeId),
      serviceIx: internService(t.serviceId),
      headsignIx: internString(t.headsign),
    });
    return ix;
  };

  // ── Per-stop columnar projection ──
  const stops: Record<string, TileStopColumns> = {};
  for (const stop of cellStops) {
    const ct = canonical.getCompactStopTimes(stop.id);
    if (!ct || ct.tripIdIdx.length === 0) {
      stops[stop.id] = {
        tripIxs: new Uint32Array(0),
        departureSecs: new Uint32Array(0),
      };
      continue;
    }

    if (ct.tripIdIdx.length !== ct.departureSecs.length) {
      // Defensive: CompactStopTimes contracts that these are parallel
      // arrays. A length mismatch here would silently zero-pad the shorter
      // side via `ct.departureSecs[i]!` evaluating to `undefined` (coerced
      // to 0 by Uint32Array), producing phantom 00:00:00 departures
      // downstream.
      throw new Error(
        `buildTileForCell: CompactStopTimes for stop "${stop.id}" has mismatched ` +
          `tripIdIdx.length (${ct.tripIdIdx.length}) vs departureSecs.length (${ct.departureSecs.length})`,
      );
    }
    const tripIxs = new Uint32Array(ct.tripIdIdx.length);
    const departureSecs = new Uint32Array(ct.departureSecs.length);
    for (let i = 0; i < ct.tripIdIdx.length; i++) {
      const canonicalTripIdx = ct.tripIdIdx[i]!;
      const tripIdStr = canonical.getTripIdForIx(canonicalTripIdx);
      if (tripIdStr === undefined) {
        throw new Error(
          `buildTileForCell: CompactStopTimes for stop "${stop.id}" references ` +
          `tripIdIdx ${canonicalTripIdx} that has no string in the canonical tripStrings table`,
        );
      }
      tripIxs[i] = internTrip(tripIdStr);
      departureSecs[i] = ct.departureSecs[i]!;
    }
    stops[stop.id] = { tripIxs, departureSecs };
  }

  return {
    bundleHash,
    cityId,
    tileSize,
    stringTable,
    routes,
    calendar,
    stops,
    trips,
  };
}
