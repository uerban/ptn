import { describe, it, expect } from "vitest";
import {
  shouldAutoActivateRider,
  findStopContextCandidates,
} from "../../src/hooks/useRiderModeDetection.ts";
import type { Leg, Departure } from "@pt/shared";

describe("shouldAutoActivateRider", () => {
  const transitLeg: Leg = {
    mode: "TRAM",
    from: { name: "Stop A", stopId: "s1", location: { lat: 54.36, lon: 18.65 } },
    to: { name: "Stop B", stopId: "s2", location: { lat: 54.37, lon: 18.66 } },
    departureTime: "2026-03-28T10:08:00Z",
    arrivalTime: "2026-03-28T10:20:00Z",
    durationSeconds: 720,
    routeShortName: "2",
    tripId: "trip_1",
  };

  it("returns true when speed exceeds vehicle threshold near transit leg start", () => {
    const pos = { lat: 54.3601, lon: 18.6501 };
    const result = shouldAutoActivateRider(transitLeg, pos, 5.0);
    expect(result).toBe(true);
  });

  it("returns false when speed is pedestrian near transit leg start", () => {
    const pos = { lat: 54.3601, lon: 18.6501 };
    const result = shouldAutoActivateRider(transitLeg, pos, 1.0);
    expect(result).toBe(false);
  });

  it("returns false when far from transit leg start", () => {
    const pos = { lat: 54.40, lon: 18.70 };
    const result = shouldAutoActivateRider(transitLeg, pos, 5.0);
    expect(result).toBe(false);
  });

  it("returns false for walking legs", () => {
    const walkLeg: Leg = {
      ...transitLeg,
      mode: "WALK",
      tripId: undefined,
    };
    const pos = { lat: 54.3601, lon: 18.6501 };
    const result = shouldAutoActivateRider(walkLeg, pos, 5.0);
    expect(result).toBe(false);
  });
});

describe("findStopContextCandidates", () => {
  it("returns departures within time window from nearby stop", () => {
    const departures: Departure[] = [
      {
        routeId: "r1",
        routeShortName: "2",
        mode: "TRAM",
        headsign: "Central",
        scheduledTime: "2026-03-28T10:08:00Z",
        tripId: "trip_1",
      },
      {
        routeId: "r2",
        routeShortName: "5",
        mode: "BUS",
        headsign: "Airport",
        scheduledTime: "2026-03-28T10:12:00Z",
        tripId: "trip_2",
      },
    ];
    const now = new Date("2026-03-28T10:05:00Z");
    const result = findStopContextCandidates(departures, now);
    expect(result).toHaveLength(2);
    expect(result[0].tripId).toBe("trip_1");
  });

  it("returns at most MAX_RIDER_CANDIDATES", () => {
    const departures: Departure[] = Array.from({ length: 5 }, (_, i) => ({
      routeId: `r${i}`,
      routeShortName: `${i}`,
      mode: "BUS" as const,
      headsign: `Line ${i}`,
      scheduledTime: `2026-03-28T10:0${i}:00Z`,
      tripId: `trip_${i}`,
    }));
    const now = new Date("2026-03-28T10:00:00Z");
    const result = findStopContextCandidates(departures, now);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("returns empty array when no departures in window", () => {
    const departures: Departure[] = [
      {
        routeId: "r1",
        routeShortName: "2",
        mode: "TRAM",
        headsign: "Central",
        scheduledTime: "2026-03-28T11:00:00Z",
        tripId: "trip_1",
      },
    ];
    const now = new Date("2026-03-28T10:00:00Z");
    const result = findStopContextCandidates(departures, now);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when more than MAX_RIDER_CANDIDATES in window (too ambiguous)", () => {
    const departures: Departure[] = Array.from({ length: 4 }, (_, i) => ({
      routeId: `r${i}`,
      routeShortName: `${i}`,
      mode: "BUS" as const,
      headsign: `Line ${i}`,
      scheduledTime: "2026-03-28T10:05:00Z",
      tripId: `trip_${i}`,
    }));
    const now = new Date("2026-03-28T10:00:00Z");
    const result = findStopContextCandidates(departures, now);
    expect(result).toHaveLength(0); // >3 = skip
  });
});
