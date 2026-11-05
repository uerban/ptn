import { describe, it, expect } from "vitest";
import type { TripResult } from "@pt/shared";
import { mapTripResult } from "./transitousResult.ts";

const baseLeg = {
  from: { name: "A", location: { lat: 1, lon: 2 } },
  to: { name: "B", location: { lat: 3, lon: 4 } },
  departureTime: "2026-06-26T08:00:00Z",
  arrivalTime: "2026-06-26T08:10:00Z",
  durationSeconds: 600,
};

describe("mapTripResult", () => {
  it("maps a transit leg, decoding its polyline", () => {
    const result: TripResult = {
      itineraries: [{
        legs: [{ ...baseLeg, mode: "BUS", routeShortName: "42", routeColor: "#f60",
                 headsign: "Center", polyline: "_p~iF~ps|U", distanceMeters: 1200 }],
        departureTime: "2026-06-26T08:00:00Z",
        arrivalTime: "2026-06-26T08:10:00Z",
        durationSeconds: 600, transfers: 0, walkingDistanceMeters: 0,
      }],
    };
    const [it] = mapTripResult(result);
    expect(it.transfers).toBe(0);
    expect(it.legs[0].mode).toBe("BUS");
    expect(it.legs[0].routeShortName).toBe("42");
    expect(it.legs[0].fromName).toBe("A");
    expect(it.legs[0].toLoc).toEqual({ lat: 3, lon: 4 });
    expect(it.legs[0].path.length).toBeGreaterThan(0); // decoded from polyline
  });

  it("falls back to endpoint coords for a leg with no polyline", () => {
    const result: TripResult = {
      itineraries: [{
        legs: [{ ...baseLeg, mode: "WALK" }],
        departureTime: "2026-06-26T08:00:00Z", arrivalTime: "2026-06-26T08:10:00Z",
        durationSeconds: 600, transfers: 0, walkingDistanceMeters: 800,
      }],
    };
    const [it] = mapTripResult(result);
    expect(it.legs[0].path).toEqual([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  });

  it("maps every itinerary and every leg, preserving order (no [0]-only collapse)", () => {
    const walk = { ...baseLeg, mode: "WALK" as const };
    const bus = { ...baseLeg, mode: "BUS" as const, routeShortName: "9" };
    const itin = (transfers: number) => ({
      legs: [walk, bus], departureTime: "2026-06-26T08:00:00Z", arrivalTime: "2026-06-26T08:10:00Z",
      durationSeconds: 600, transfers, walkingDistanceMeters: 100,
    });
    const result: TripResult = { itineraries: [itin(0), itin(1)] };
    const out = mapTripResult(result);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.transfers)).toEqual([0, 1]);
    expect(out[1].legs.map((l) => l.mode)).toEqual(["WALK", "BUS"]);
    expect(out[1].legs[1].routeShortName).toBe("9");
  });

  it("maps a zero-leg itinerary to an empty leg list (no throw)", () => {
    const result: TripResult = {
      itineraries: [{
        legs: [], departureTime: "2026-06-26T08:00:00Z", arrivalTime: "2026-06-26T08:00:00Z",
        durationSeconds: 0, transfers: 0, walkingDistanceMeters: 0,
      }],
    };
    const [it] = mapTripResult(result);
    expect(it.legs).toEqual([]);
  });

  it("leaves absent optional fields undefined", () => {
    const result: TripResult = {
      itineraries: [{
        legs: [{ ...baseLeg, mode: "WALK" }],
        departureTime: "2026-06-26T08:00:00Z", arrivalTime: "2026-06-26T08:10:00Z",
        durationSeconds: 600, transfers: 0, walkingDistanceMeters: 800,
      }],
    };
    const [it] = mapTripResult(result);
    expect(it.legs[0].routeShortName).toBeUndefined();
    expect(it.legs[0].routeColor).toBeUndefined();
    expect(it.legs[0].headsign).toBeUndefined();
  });
});
