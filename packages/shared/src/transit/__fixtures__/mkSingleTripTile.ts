import type {
  DecodedScheduleTile,
  CalendarRow,
  DaysOfWeek,
  RouteRow,
  TileTripRow,
} from "../../types/scheduleTile.js";
import type { TransportMode } from "../../types/transit.js";
import { SCHEDULE_TILE_EDGE_METERS } from "../../poi/tileParams.js";

/** Inputs for `mkSingleTripTile`. Required fields are minimal; the rest default. */
export interface MkSingleTripTileInput {
  /** GTFS canonical `trip_id`. */
  tripId: string;
  /** GTFS canonical `route_id`. */
  routeId: string;
  /** Display short name (e.g. "42"). */
  routeShortName: string;
  /** Transport mode. */
  mode: TransportMode;
  /** Trip headsign / destination sign. */
  headsign: string;
  /** GTFS canonical `service_id`. */
  serviceId: string;
  /**
 * Stop the trip touches (single-stop helper — full tiles will use `mkFixture` in).
 */
  stopId: string;
  /** Boarding offset in seconds since base midnight; may exceed 86400 for overnight trips. */
  departureSec: number;
  /** Day-of-week mask in `[mon, tue, wed, thu, fri, sat, sun]` order. */
  activeDays: DaysOfWeek;

  // Optional overrides — defaults are spelled out below.
  routeColor?: string;
  subMode?: string;
  longName?: string;
  startDate?: string;
  endDate?: string;
  /** YYYYMMDD dates added by `calendar_dates.txt` (matches `CalendarRow.added`). */
  added?: readonly string[];
  /** YYYYMMDD dates removed by `calendar_dates.txt` (matches `CalendarRow.removed`). */
  removed?: readonly string[];
  bundleHash?: string;
  cityId?: string;
  tileSize?: number;
}

/**
 * Construct a minimal single-trip `DecodedScheduleTile`. Used by the parity
 * oracle (Tasks 1.9–1.23) and by the `getDeparturesFromTile` test suite.
 *
 * Defaults: `bundleHash="deadbeef"`, `cityId="test"`, `tileSize=12000`,
 * `longName=routeShortName`, `startDate="20260101"`, `endDate="20261231"`,
 * empty `added`/`removed`. Override only when a test exercises a
 * non-default value.
 */
export function mkSingleTripTile(input: MkSingleTripTileInput): DecodedScheduleTile {
  const stringTable: string[] = [input.tripId, input.headsign];
  const tripIdIx = 0;
  const headsignIx = 1;

  const routes: RouteRow[] = [
    {
      id: input.routeId,
      shortName: input.routeShortName,
      longName: input.longName ?? input.routeShortName,
      color: input.routeColor,
      mode: input.mode,
      subMode: input.subMode,
    },
  ];

  const calendar: CalendarRow[] = [
    {
      serviceId: input.serviceId,
      days: input.activeDays,
      startDate: input.startDate ?? "20260101",
      endDate: input.endDate ?? "20261231",
      added: input.added ?? [],
      removed: input.removed ?? [],
    },
  ];

  const trips: TileTripRow[] = [
    { tripIdIx, routeIx: 0, serviceIx: 0, headsignIx },
  ];

  const stops = {
    [input.stopId]: {
      tripIxs: new Uint32Array([0]),
      departureSecs: new Uint32Array([input.departureSec]),
    },
  };

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
