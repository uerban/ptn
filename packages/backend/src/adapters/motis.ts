import type {
  RoutingAdapter,
  TripQuery,
  TripResult,
  Stop,
  Departure,
  VehiclePosition,
  Itinerary,
  Leg,
  LatLon,
  TransportMode,
  CityProfile,
} from "@pt/shared";
import { TRANSITOUS_API_URL } from "@pt/shared";
import { buildInfo } from "../generated/buildInfo.js";

/**
 * Identifies this client to the upstream routing API.
 *
 * Transitous is a volunteer-run community deployment and rejects undici's
 * default `User-Agent: node` with 403 Forbidden. Node's fetch supplies that
 * default whenever a request sets no User-Agent of its own, so omitting the
 * header here fails every call — including from the same host and IP where a
 * curl request with any other UA succeeds. Send a descriptive UA with a
 * contact URL instead, which is what a shared community API expects and what
 * lets its operators reach us rather than block us.
 */
const USER_AGENT = `PTN/${buildInfo.version} (+https://github.com/uerban/ptn)`;

/**
 * MOTIS adapter using the Transitous public API.
 * API docs: https://routing.spline.de/openapi/
 */
/** Geographic envelope of the city a deployment serves. Mirrors `CityProfile.bbox`. */
type CityBBox = CityProfile["bbox"];

export class MotisAdapter implements RoutingAdapter {
  readonly name = "motis";
  private readonly baseUrl: string;
  private readonly cityBbox?: CityBBox;

  /**
   * @param cityBbox Envelope of the city this deployment serves. When set,
   * `searchStops` orders local matches first. Omit for cross-city or test use
   * — the adapter then returns upstream order untouched.
   */
  constructor(baseUrl?: string, cityBbox?: CityBBox) {
    this.baseUrl = baseUrl || TRANSITOUS_API_URL;
    this.cityBbox = cityBbox;
  }

  async planTrip(query: TripQuery): Promise<TripResult> {
    const params = new URLSearchParams();
    params.set("fromPlace", `${query.from.lat},${query.from.lon}`);
    params.set("toPlace", `${query.to.lat},${query.to.lon}`);

    if (query.departAt) {
      params.set("time", query.departAt);
      params.set("arriveBy", "false");
    } else if (query.arriveBy) {
      params.set("time", query.arriveBy);
      params.set("arriveBy", "true");
    }

    if (query.maxTransfers !== undefined) {
      params.set("maxTransfers", String(query.maxTransfers));
    }

    if (query.cursor) {
      params.set("pageCursor", query.cursor);
    }

    const response = await this.fetch(`/v1/plan?${params.toString()}`);
    const data = await response.json();

    // MOTIS reports transit-free journeys in a separate `direct` array rather
    // than alongside the transit ones, and reads it as time-invariant: the same
    // walk comes back on every page, with no cursor of its own. Carry it
    // through under its own name — merging it into `itineraries` would both
    // duplicate it across pages and destroy the "no transit route here" answer
    // that an empty `itineraries` conveys.
    const direct: Itinerary[] = (data.direct ?? []).map(mapItinerary);

    return {
      itineraries: (data.itineraries ?? []).map(mapItinerary),
      ...(direct.length > 0 ? { direct } : {}),
      nextPageCursor: data.nextPageCursor ?? undefined,
    };
  }

  async getNearbyStops(
    location: LatLon,
    radiusMeters = 500
  ): Promise<Stop[]> {
    // MOTIS geocode with reverse geocoding
    const params = new URLSearchParams();
    params.set("place", `${location.lat},${location.lon}`);
    params.set("radius", String(radiusMeters));
    // Filter to stops server-side. Without this the endpoint returns only the
    // ~5 nearest features of any kind — addresses, POIs, stops — and at a busy
    // interchange those slots fill with street addresses, leaving the
    // client-side `type === "STOP"` filter below with nothing. `radius` does
    // not help: the response is identical at 100 m and 10 km, so it is the
    // result count, not the search area, that squeezes stops out.
    params.set("type", "STOP");

    const response = await this.fetch(
      `/v1/reverse-geocode?${params.toString()}`
    );
    const data = await response.json();
    return (data ?? [])
      .filter((item: any) => item.type === "STOP")
      .slice(0, 200)
      .map(mapGeocodedStop);
  }

  async getDepartures(
    stopId: string,
    time?: Date,
    limit = 20
  ): Promise<Departure[]> {
    const params = new URLSearchParams();
    params.set("stopId", stopId);
    if (time) {
      params.set("time", time.toISOString());
    }
    params.set("n", String(limit));

    const response = await this.fetch(
      `/v1/stoptimes?${params.toString()}`
    );
    const data = await response.json();

    return (data.stopTimes ?? []).map(mapDeparture);
  }

  async searchStops(query: string, limit = 10): Promise<Stop[]> {
    const params = new URLSearchParams();
    params.set("text", query);

    const response = await this.fetch(
      `/v1/geocode?${params.toString()}`
    );
    const data = await response.json();

    const stops: Stop[] = (data ?? [])
      .filter((item: any) => item.type === "STOP")
      .map(mapGeocodedStop);

    // Order before truncating, or the promotion is pointless: the local match
    // this exists to surface is precisely the one sitting past `limit`.
    return orderLocalFirst(stops, this.cityBbox).slice(0, limit);
  }

  async getVehiclePositions(_bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  }): Promise<VehiclePosition[]> {
    // Vehicle positions require GTFS-RT feeds — Phase 2
    return [];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetch("/v1/geocode?text=test");
      return response.ok;
    } catch {
      return false;
    }
  }

  private async fetch(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(
        `MOTIS API error: ${response.status} ${response.statusText}`
      );
    }
    return response;
  }
}

// --- Response Mapping ---

function mapItinerary(raw: any): Itinerary {
  const legs: Leg[] = (raw.legs ?? []).map(mapLeg);
  const walkingDistance = legs
    .filter((l) => l.mode === "WALK")
    .reduce((sum, l) => sum + (l.distanceMeters ?? 0), 0);

  return {
    legs,
    departureTime: raw.startTime ?? raw.legs?.[0]?.startTime ?? "",
    arrivalTime:
      raw.endTime ??
      raw.legs?.[raw.legs?.length - 1]?.endTime ??
      "",
    durationSeconds: raw.duration ?? 0,
    transfers: raw.transfers ?? Math.max(0, legs.filter((l) => l.mode !== "WALK").length - 1),
    walkingDistanceMeters: walkingDistance,
    paginationCursor: raw.pageCursor,
  };
}

function mapLeg(raw: any): Leg {
  return {
    mode: mapTransportMode(raw.mode),
    from: {
      name: raw.from?.name ?? "",
      stopId: raw.from?.stopId,
      location: {
        lat: raw.from?.lat ?? 0,
        lon: raw.from?.lon ?? 0,
      },
    },
    to: {
      name: raw.to?.name ?? "",
      stopId: raw.to?.stopId,
      location: {
        lat: raw.to?.lat ?? 0,
        lon: raw.to?.lon ?? 0,
      },
    },
    departureTime: raw.startTime ?? raw.from?.departure ?? "",
    arrivalTime: raw.endTime ?? raw.to?.arrival ?? "",
    durationSeconds: raw.duration ?? 0,
    routeShortName: raw.routeShortName ?? raw.route,
    routeColor: raw.routeColor,
    tripId: raw.tripId,
    headsign: raw.headsign,
    intermediateStops: Array.isArray(raw.intermediateStops)
      ? raw.intermediateStops.length
      : (raw.intermediateStops ?? 0),
    polyline: raw.legGeometry?.points,
    distanceMeters: raw.distance,
    delaySeconds: raw.departureDelay,
  };
}

/**
 * Moves stops inside `bbox` ahead of stops outside it, preserving upstream
 * order within each group.
 *
 * Generic stop names repeat across a country — "Geležinkelio stotis" is simply
 * Lithuanian for "railway station" and exists in most Lithuanian cities — and
 * the geocoder has no idea which city this deployment serves. The local match
 * can therefore rank below `limit` and be truncated away before anyone sees
 * it, leaving a Vilnius user looking at Kaunas stops with no visible clue,
 * since `Stop` carries no city label.
 *
 * Ordering rather than filtering is deliberate. The remote search provider is
 * the opt-in path for finding stops the downloaded city bundle does NOT have,
 * so out-of-city results have to stay reachable — just not ahead of local
 * ones. Filtering would also make the result count depend on geography, which
 * `limit` does not promise.
 *
 * Note this cannot conjure a local match the geocoder never returned: when
 * upstream sends nothing inside the bbox, ordering changes nothing.
 *
 * No-op without a bbox, which is how cross-city and test callers construct
 * the adapter.
 */
function orderLocalFirst(stops: Stop[], bbox?: CityBBox): Stop[] {
  if (!bbox) return stops;
  const isLocal = (s: Stop) =>
    s.location.lat >= bbox.minLat &&
    s.location.lat <= bbox.maxLat &&
    s.location.lon >= bbox.minLon &&
    s.location.lon <= bbox.maxLon;
  // Partition rather than sort with a comparator: this states the intent
  // directly and keeps the within-group order upstream chose, which is still
  // the best relevance signal available for stops on the same side of the line.
  return [...stops.filter(isLocal), ...stops.filter((s) => !isLocal(s))];
}

function mapGeocodedStop(raw: any): Stop {
  return {
    id: raw.id ?? raw.stopId ?? "",
    name: raw.name ?? raw.displayName ?? "",
    location: {
      lat: raw.lat ?? 0,
      lon: raw.lon ?? 0,
    },
  };
}

function mapDeparture(raw: any): Departure {
  const scheduled = raw.place?.scheduledDeparture ?? raw.place?.departure ?? "";
  const actual = raw.place?.departure ?? "";
  let delaySeconds: number | undefined;
  if (raw.realTime && raw.place?.scheduledDeparture && actual) {
    const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 1000;
    if (Number.isFinite(diff)) delaySeconds = diff;
  }
  return {
    routeId: raw.routeId ?? "",
    routeShortName: raw.routeShortName ?? raw.route ?? "",
    routeColor: raw.routeColor,
    mode: mapTransportMode(raw.mode),
    headsign: raw.headsign ?? "",
    scheduledTime: scheduled,
    predictedTime: raw.realTime ? actual || undefined : undefined,
    delaySeconds,
    tripId: raw.tripId ?? "",
    cancelled: raw.cancelled ?? false,
  };
}

function mapTransportMode(mode?: string): TransportMode {
  if (!mode) return "BUS";
  const upper = mode.toUpperCase();
  const mapping: Record<string, TransportMode> = {
    BUS: "BUS",
    TRAM: "TRAM",
    SUBWAY: "METRO",
    METRO: "METRO",
    RAIL: "RAIL",
    REGIONAL_FAST_RAIL: "RAIL",
    REGIONAL_RAIL: "RAIL",
    LONG_DISTANCE: "RAIL",
    HIGHSPEED_RAIL: "RAIL",
    NIGHT_RAIL: "RAIL",
    COACH: "BUS",
    FERRY: "FERRY",
    WATER: "FERRY",
    CABLE_CAR: "CABLE_TRAM",
    FUNICULAR: "FUNICULAR",
    AERIAL_LIFT: "AERIAL",
    WALK: "WALK",
    BIKE: "BIKE",
    BIKE_RENTAL: "BIKE_SHARE",
    CAR: "CAR",
    SCOOTER: "SCOOTER",
    SUBURBAN: "RAIL",
  };
  return mapping[upper] ?? "BUS";
}
