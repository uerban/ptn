import type { Itinerary, Leg } from "@pt/shared";

const t0 = Date.parse("2026-04-23T12:00:00Z");
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60_000).toISOString();

/**
 * Itinerary covering all four toSegments() kinds:
 *   BUS (ride) 0→8min → wait at same stop 8→10min (tight) → TRAM (ride) 10→18min → WALK (transferWalk) 18→20min.
 */
export function makeMixedItinerary(): Itinerary {
  const legs: Leg[] = [
    {
      mode: "BUS",
      from: { name: "A", stopId: "s1", location: { lat: 0, lon: 0 } },
      to: { name: "B", stopId: "s2", location: { lat: 0, lon: 0 } },
      departureTime: iso(0),
      arrivalTime: iso(8),
      durationSeconds: 480,
      routeShortName: "5",
      routeColor: "#ff0000",
      tripId: "T1",
      routeId: "R1",
      intermediateStops: 2,
    },
    {
      mode: "TRAM",
      from: { name: "B", stopId: "s2", location: { lat: 0, lon: 0 } },
      to: { name: "C", stopId: "s3", location: { lat: 0, lon: 0 } },
      departureTime: iso(10),
      arrivalTime: iso(18),
      durationSeconds: 480,
      routeShortName: "3",
      routeColor: "#0000ff",
      tripId: "T2",
      routeId: "R2",
      intermediateStops: 1,
    },
    {
      mode: "WALK",
      from: { name: "C", stopId: "s3", location: { lat: 0, lon: 0 } },
      to: { name: "D", stopId: "s4", location: { lat: 0.001, lon: 0 } },
      departureTime: iso(18),
      arrivalTime: iso(20),
      durationSeconds: 120,
      distanceMeters: 120,
    },
  ];
  return {
    departureTime: iso(0),
    arrivalTime: iso(20),
    durationSeconds: 1200,
    transfers: 1,
    walkingDistanceMeters: 120,
    legs,
  };
}
