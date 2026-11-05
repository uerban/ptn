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

/**
 * OpenTripPlanner (OTP) adapter.
 * Compatible with OTP v1 REST API (/routers/default/...).
 *
 * Key differences from MOTIS:
 * - Timestamps are Unix milliseconds (not ISO 8601)
 * - Routing response wraps itineraries in `plan.itineraries`
 * - Route colors have no `#` prefix (same raw hex string as MOTIS)
 */
export class OtpAdapter implements RoutingAdapter {
  readonly name = "otp";
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async planTrip(query: TripQuery): Promise<TripResult> {
    const params = new URLSearchParams();
    params.set("fromPlace", `${query.from.lat},${query.from.lon}`);
    params.set("toPlace", `${query.to.lat},${query.to.lon}`);

    const refTime = query.departAt ?? query.arriveBy;
    if (refTime) {
      // OTP expects date=YYYY-MM-DD and time=HH:MM separately
      const dt = new Date(refTime);
      const yyyy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const dd = String(dt.getDate()).padStart(2, "0");
      const hours = String(dt.getHours()).padStart(2, "0");
      const minutes = String(dt.getMinutes()).padStart(2, "0");
      params.set("date", `${yyyy}-${mm}-${dd}`);
      params.set("time", `${hours}:${minutes}`);
      if (query.arriveBy) {
        params.set("arriveBy", "true");
      }
    }

    if (query.maxTransfers !== undefined) {
      params.set("maxTransfers", String(query.maxTransfers));
    }

    const response = await this.fetch(
      `/routers/default/plan?${params.toString()}`
    );
    const data = await response.json();

    if (data.error) {
      console.warn("OTP routing error:", data.error.msg ?? data.error.message ?? data.error);
    }

    return {
      itineraries: ((data.plan?.itineraries) ?? []).map(mapItinerary),
    };
  }

  async getNearbyStops(
    location: LatLon,
    radiusMeters = 500
  ): Promise<Stop[]> {
    const params = new URLSearchParams();
    params.set("lat", String(location.lat));
    params.set("lon", String(location.lon));
    params.set("radius", String(radiusMeters));

    const response = await this.fetch(
      `/routers/default/index/stops?${params.toString()}`
    );
    const data = await response.json();
    return (data ?? []).slice(0, 200).map(mapIndexStop);
  }

  async getDepartures(
    stopId: string,
    _time?: Date,
    limit = 20
  ): Promise<Departure[]> {
    const params = new URLSearchParams();
    params.set("numberOfDepartures", String(limit));

    const response = await this.fetch(
      `/routers/default/index/stops/${encodeURIComponent(stopId)}/stoptimes?${params.toString()}`
    );
    const data = await response.json();
    return (data ?? []).map(mapStoptime);
  }

  async searchStops(query: string, limit = 10): Promise<Stop[]> {
    const params = new URLSearchParams();
    params.set("query", query);

    const response = await this.fetch(
      `/routers/default/geocode?${params.toString()}`
    );
    const data = await response.json();

    return (data ?? []).slice(0, limit).map(mapGeocodeResult);
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

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetch("/routers/default");
      return response.ok;
    } catch (err) {
      console.warn("OTP health check failed:", err);
      return false;
    }
  }

  private async fetch(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `OTP API error: ${response.status} ${response.statusText}`
      );
    }
    return response;
  }
}

// --- Response Mapping ---

/** Convert Unix milliseconds to ISO 8601 UTC string */
function msToIso(ms?: number): string {
  if (ms == null) return "";
  return new Date(ms).toISOString();
}

function mapItinerary(raw: any): Itinerary {
  const legs: Leg[] = (raw.legs ?? []).map(mapLeg);
  const walkingDistance = legs
    .filter((l) => l.mode === "WALK")
    .reduce((sum, l) => sum + (l.distanceMeters ?? 0), 0);

  return {
    legs,
    departureTime: msToIso(raw.startTime),
    arrivalTime: msToIso(raw.endTime),
    durationSeconds: raw.duration ?? 0,
    transfers: raw.transfers ?? Math.max(0, legs.filter((l) => l.mode !== "WALK").length - 1),
    walkingDistanceMeters: walkingDistance,
  };
}

function mapLeg(raw: any): Leg {
  // OTP leg routeColor: hex without '#'
  const routeColor = raw.routeColor ?? undefined;

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
    departureTime: msToIso(raw.startTime),
    arrivalTime: msToIso(raw.endTime),
    durationSeconds: raw.duration ?? 0,
    routeShortName: raw.routeShortName ?? raw.route,
    routeColor,
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

function mapIndexStop(raw: any): Stop {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    location: {
      lat: raw.lat ?? 0,
      lon: raw.lon ?? 0,
    },
  };
}

function mapGeocodeResult(raw: any): Stop {
  return {
    id: raw.id ?? "",
    name: raw.description ?? raw.name ?? "",
    location: {
      lat: raw.lat ?? 0,
      lon: raw.lon ?? 0,
    },
  };
}

function mapStoptime(raw: any): Departure {
  const scheduledMs: number = raw.serviceDay * 1000 + raw.scheduledDeparture * 1000;
  const realtimeMs: number | undefined = raw.realtime
    ? raw.serviceDay * 1000 + raw.realtimeDeparture * 1000
    : undefined;

  const scheduledTime = new Date(scheduledMs).toISOString();
  const predictedTime = realtimeMs !== undefined
    ? new Date(realtimeMs).toISOString()
    : undefined;

  let delaySeconds: number | undefined;
  if (raw.realtime && realtimeMs !== undefined) {
    delaySeconds = (realtimeMs - scheduledMs) / 1000;
  }

  const trip = raw.trip ?? {};
  const pattern = raw.pattern ?? {};

  return {
    routeId: trip.routeId ?? pattern.id ?? "",
    routeShortName: trip.shortName ?? trip.routeId ?? "",
    routeColor: trip.routeColor ?? pattern.routeColor,
    mode: mapTransportMode(trip.mode ?? pattern.mode),
    headsign: raw.headsign ?? trip.tripHeadsign ?? "",
    scheduledTime,
    predictedTime,
    delaySeconds,
    tripId: trip.id ?? "",
    cancelled: raw.timepoint === 0 ? false : (raw.cancelled ?? false),
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
    GONDOLA: "AERIAL",
    CABLE_CAR: "CABLE_TRAM",
    FUNICULAR: "FUNICULAR",
    FERRY: "FERRY",
    WALK: "WALK",
    BICYCLE: "BIKE",
    CAR: "CAR",
  };
  return mapping[upper] ?? "BUS";
}
