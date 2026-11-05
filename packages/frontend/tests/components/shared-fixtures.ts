import type { Itinerary, Leg, LegPlace, TransportMode } from "@pt/shared";

export function place(name: string, lat = 0, lon = 0, stopId?: string): LegPlace {
  return { name, stopId, location: { lat, lon } };
}

export function ride(overrides: {
  mode?: TransportMode;
  from: LegPlace;
  to: LegPlace;
  depart: string;
  arrive: string;
  routeShortName?: string;
  delaySeconds?: number;
}): Leg {
  const depart = new Date(overrides.depart).getTime();
  const arrive = new Date(overrides.arrive).getTime();
  return {
    mode: overrides.mode ?? "BUS",
    from: overrides.from,
    to: overrides.to,
    departureTime: overrides.depart,
    arrivalTime: overrides.arrive,
    durationSeconds: Math.max(0, Math.round((arrive - depart) / 1000)),
    routeShortName: overrides.routeShortName,
    delaySeconds: overrides.delaySeconds,
  };
}

export function walk(overrides: {
  from: LegPlace;
  to: LegPlace;
  depart: string;
  arrive: string;
  meters?: number;
}): Leg {
  const depart = new Date(overrides.depart).getTime();
  const arrive = new Date(overrides.arrive).getTime();
  return {
    mode: "WALK",
    from: overrides.from,
    to: overrides.to,
    departureTime: overrides.depart,
    arrivalTime: overrides.arrive,
    durationSeconds: Math.max(0, Math.round((arrive - depart) / 1000)),
    distanceMeters: overrides.meters ?? 0,
  };
}

export function itinerary(legs: Leg[], transfers = 0): Itinerary {
  return {
    legs,
    departureTime: legs[0]!.departureTime,
    arrivalTime: legs[legs.length - 1]!.arrivalTime,
    durationSeconds: Math.max(
      0,
      Math.round(
        (new Date(legs[legs.length - 1]!.arrivalTime).getTime() -
          new Date(legs[0]!.departureTime).getTime()) /
          1000,
      ),
    ),
    transfers,
    walkingDistanceMeters: 0,
  };
}

export const ms = (iso: string): number => new Date(iso).getTime();
