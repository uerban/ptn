import type {
  RoutingAdapter,
  TripQuery,
  TripResult,
  Stop,
  Departure,
  Alert,
  VehiclePosition,
  Itinerary,
  Leg,
  LatLon,
  TransportMode,
} from "@pt/shared";

// pt-serve emits LEG fields in snake_case (the WireLeg enum's serde `rename_all` renames
// variants, not struct-variant fields), while ITINERARY fields are camelCase (the
// WireItinerary struct's `rename_all` does rename fields). Verified against live bytes.
interface WireLeg {
  type: "walk" | "transit";
  from_stop_id: string;
  to_stop_id: string;
  depart_secs: number;
  arrive_secs: number;
  mode: string;
  route_id?: string;
  trip_id?: string;
  intermediate_stops?: number;
}

interface WireItinerary {
  legs: WireLeg[];
  boardSecs: number;
  alightSecs: number;
  transfers: number;
}

/** secs-since-service-day-LOCAL-midnight (+ YYYYMMDD + the feed's UTC offset) → the
 *  CORRECT ISO-8601 UTC instant. pt-serve/RAPTOR secs are relative to LOCAL midnight,
 *  but OTP reports true UTC epoch — so to compare arrivals on the SAME absolute instant
 *  we must subtract the offset. Oslo = Europe/Oslo (+7200s in June). A local wall-clock
 *  arrival `secs` after local midnight is the UTC instant Date.UTC(y,m,d) + (secs −
 *  tzOffsetSecs)*1000 (local midnight in UTC is Date.UTC(y,m,d) − tzOffsetSecs).
 *  (Slice simplification: a fixed offset passed in; the follow-on sources a DST-aware
 *  offset from the bundle's `cityTzOffsetSeconds` / `agency_timezone`.) */
function secsToIso(date: number, secs: number, tzOffsetSecs: number): string {
  const y = Math.floor(date / 10000);
  const m = Math.floor((date % 10000) / 100);
  const d = date % 100;
  return new Date(Date.UTC(y, m - 1, d) + (secs - tzOffsetSecs) * 1000).toISOString();
}

export function wireToItinerary(w: WireItinerary, date: number, tzOffsetSecs = 7200): Itinerary {
  const legs: Leg[] = w.legs.map((l) => ({
    mode: l.mode as TransportMode,
    from: { name: "", stopId: l.from_stop_id, location: { lat: 0, lon: 0 } },
    to: { name: "", stopId: l.to_stop_id, location: { lat: 0, lon: 0 } },
    departureTime: secsToIso(date, l.depart_secs, tzOffsetSecs),
    arrivalTime: secsToIso(date, l.arrive_secs, tzOffsetSecs),
    durationSeconds: l.arrive_secs - l.depart_secs,
    routeShortName: undefined,
    tripId: l.trip_id,
    intermediateStops: l.intermediate_stops ?? 0,
  }));
  return {
    legs,
    departureTime: secsToIso(date, w.boardSecs, tzOffsetSecs),
    arrivalTime: secsToIso(date, w.alightSecs, tzOffsetSecs),
    durationSeconds: w.alightSecs - w.boardSecs,
    transfers: w.transfers,
    walkingDistanceMeters: 0, // pt-serve walk legs carry no distance; harness compares transit timing
  };
}

/**
 * RoutingAdapter over pt-serve Contract-A. NOTE: this adapter takes a STOP-ANCHORED query
 * (`entryStopIds`/`exitStopIds`), which is an extension of the shared coordinate-shaped
 * `TripQuery` — so it is NOT registered in the shared `createAdapterRegistry()` (the registry's
 * callers, e.g. `benchmark.ts`, pass coordinate queries that this adapter cannot serve; see 's
 * direct instantiation). `excludedModes` is passed as route_type ints (pt-serve's wire form),
 * NOT TransportMode strings — pt-serve 400s on the string form (wire.rs note). `tzOffsetSecs`
 * converts pt-serve's local-midnight secs to the correct UTC instant (default Oslo +7200).
 */
export class RaptorAdapter implements RoutingAdapter {
  readonly name = "raptor";

  constructor(
    private readonly baseUrl: string,
    private readonly city: string,
    private readonly tzOffsetSecs = 7200,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async planTrip(query: TripQuery): Promise<TripResult> {
    const q = query as TripQuery & {
      date?: number;
      departureSecs?: number;
      entryStopIds?: string[];
      exitStopIds?: string[];
      excludedRouteTypes?: number[];
    };
    if (!q.entryStopIds || !q.exitStopIds || q.date == null || q.departureSecs == null) {
      throw new Error(
        "RaptorAdapter requires a stop-anchored query {entryStopIds,exitStopIds,date,departureSecs}; the coordinate TripQuery form is not supported.",
      );
    }
    const body = {
      entryStops: q.entryStopIds.map((stopId) => ({ stopId, walkSecs: 0 })),
      exitStops: q.exitStopIds.map((stopId) => ({ stopId, walkSecs: 0 })),
      departureSecs: q.departureSecs,
      date: String(q.date),
      mobilityProfile: q.mobilityProfile ?? "default",
      ...(q.excludedRouteTypes && q.excludedRouteTypes.length
        ? { excludedModes: q.excludedRouteTypes }
        : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/${this.city}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`pt-serve plan ${res.status}: ${await res.text()}`);
    const wire = (await res.json()) as WireItinerary[];
    return { itineraries: wire.map((w) => wireToItinerary(w, q.date!, this.tzOffsetSecs)) };
  }

  async healthCheck(): Promise<boolean> {
    try {
      return (await fetch(`${this.baseUrl}/ready`)).ok;
    } catch {
      return false;
    }
  }

  async getNearbyStops(_l: LatLon, _r?: number): Promise<Stop[]> {
    return [];
  }

  async getDepartures(_s: string, _t?: Date, _l?: number): Promise<Departure[]> {
    return [];
  }

  async searchStops(_q: string, _l?: number): Promise<Stop[]> {
    return [];
  }

  async getAlerts(): Promise<Alert[]> {
    return [];
  }

  async getVehiclePositions(_bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  }): Promise<VehiclePosition[]> {
    return [];
  }
}
