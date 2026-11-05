import type {
  DecodedScheduleTile,
  CalendarRow,
  DaysOfWeek,
  RouteRow,
  TileTripRow,
  TileStopColumns,
} from "../../types/scheduleTile.js";
import type { TransportMode } from "../../types/transit.js";
import { SCHEDULE_TILE_EDGE_METERS } from "../../poi/tileParams.js";

export interface MkFixtureService {
  id: string;
  days: DaysOfWeek;
  startDate?: string;
  endDate?: string;
  added?: readonly string[];
  removed?: readonly string[];
}

export interface MkFixtureRoute {
  id: string;
  shortName: string;
  mode: TransportMode;
  longName?: string;
  color?: string;
  subMode?: string;
}

export interface MkFixtureStopTime {
  stopId: string;
  departureSec: number;
}

export interface MkFixtureTrip {
  tripId: string;
  routeId: string;
  serviceId: string;
  headsign: string;
  stopTimes: readonly MkFixtureStopTime[];
}

export interface MkFixtureInput {
  services: readonly MkFixtureService[];
  routes: readonly MkFixtureRoute[];
  trips: readonly MkFixtureTrip[];
  bundleHash?: string;
  cityId?: string;
  tileSize?: number;
}

/**
 * Build a `DecodedScheduleTile` from declarative inputs. Stop-major
 * columns are sorted ascending by `departureSec`; the parallel `tripIxs`
 * vector tracks the trip's index in `trips`. String values
 * (tripId, headsign) are deduped into a single `stringTable`.
 *
 * Throws if a trip references a routeId or serviceId not present in the
 * `routes` / `services` arrays — fail loud so a mistyped fixture is
 * caught at construction, not at assertion time.
 */
export function mkFixture(input: MkFixtureInput): DecodedScheduleTile {
  // ── String intern table ──
  const stringTable: string[] = [];
  const stringIx = new Map<string, number>();
  const internString = (s: string): number => {
    let ix = stringIx.get(s);
    if (ix === undefined) {
      ix = stringTable.length;
      stringIx.set(s, ix);
      stringTable.push(s);
    }
    return ix;
  };

  // ── Calendar ──
  const calendar: CalendarRow[] = input.services.map((svc) => ({
    serviceId: svc.id,
    days: svc.days,
    startDate: svc.startDate ?? "20260101",
    endDate: svc.endDate ?? "20261231",
    added: svc.added ?? [],
    removed: svc.removed ?? [],
  }));
  const serviceIxById = new Map<string, number>();
  calendar.forEach((row, ix) => serviceIxById.set(row.serviceId, ix));

  // ── Routes ──
  const routes: RouteRow[] = input.routes.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    longName: r.longName ?? r.shortName,
    color: r.color,
    mode: r.mode,
    subMode: r.subMode,
  }));
  const routeIxById = new Map<string, number>();
  routes.forEach((row, ix) => routeIxById.set(row.id, ix));

  // ── Trips + stop columns ──
  const trips: TileTripRow[] = [];
  const stopAccum = new Map<string, { tripIxs: number[]; departureSecs: number[] }>();

  for (const trip of input.trips) {
    const routeIx = routeIxById.get(trip.routeId);
    if (routeIx === undefined) {
      throw new Error(`mkFixture: unknown routeId "${trip.routeId}" referenced by trip "${trip.tripId}"`);
    }
    const serviceIx = serviceIxById.get(trip.serviceId);
    if (serviceIx === undefined) {
      throw new Error(`mkFixture: unknown serviceId "${trip.serviceId}" referenced by trip "${trip.tripId}"`);
    }

    const tripIdIx = internString(trip.tripId);
    const headsignIx = internString(trip.headsign);
    const tripIx = trips.length;
    trips.push({ tripIdIx, routeIx, serviceIx, headsignIx });

    for (const st of trip.stopTimes) {
      let acc = stopAccum.get(st.stopId);
      if (!acc) {
        acc = { tripIxs: [], departureSecs: [] };
        stopAccum.set(st.stopId, acc);
      }
      acc.tripIxs.push(tripIx);
      acc.departureSecs.push(st.departureSec);
    }
  }

  // ── Sort each stop's columns by departureSec; build typed arrays ──
  const stops: Record<string, TileStopColumns> = {};
  for (const [stopId, { tripIxs, departureSecs }] of stopAccum) {
    const order = departureSecs
      .map((_, i) => i)
      .sort((a, b) => departureSecs[a]! - departureSecs[b]!);
    const sortedTripIxs = new Uint32Array(order.map((i) => tripIxs[i]!));
    const sortedDepSecs = new Uint32Array(order.map((i) => departureSecs[i]!));
    stops[stopId] = { tripIxs: sortedTripIxs, departureSecs: sortedDepSecs };
  }

  return {
    bundleHash: input.bundleHash ?? "deadbeef",
    cityId: input.cityId ?? "test",
    tileSize: input.tileSize ?? SCHEDULE_TILE_EDGE_METERS,
    stringTable,
    routes,
    calendar,
    stops,
    trips,
  };
}
