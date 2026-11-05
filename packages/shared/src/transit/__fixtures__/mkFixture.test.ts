import { describe, it, expect } from "vitest";
import { mkFixture } from "./mkFixture.js";

describe("mkFixture", () => {
  it("composes a multi-trip multi-stop tile with stop-major columns sorted by departureSec", () => {
    const tile = mkFixture({
      services: [
        { id: "SVC_DAILY", days: [true, true, true, true, true, true, true] },
      ],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [
        {
          tripId: "T1", routeId: "R1", serviceId: "SVC_DAILY", headsign: "Downtown",
          stopTimes: [
            { stopId: "S1", departureSec: 8 * 3600 },
            { stopId: "S2", departureSec: 8 * 3600 + 300 }, // 08:05
          ],
        },
        {
          tripId: "T2", routeId: "R1", serviceId: "SVC_DAILY", headsign: "Downtown",
          stopTimes: [
            { stopId: "S1", departureSec: 7 * 3600 + 1800 }, // 07:30 — earlier than T1
            { stopId: "S2", departureSec: 7 * 3600 + 2100 },
          ],
        },
      ],
    });

    // Stop S1 has both trips; columns sorted by departureSec ascending.
    expect(tile.stops.S1).toBeDefined();
    expect(Array.from(tile.stops.S1!.departureSecs)).toEqual([7 * 3600 + 1800, 8 * 3600]);
    // tripIxs parallel to departureSecs: T2 first (07:30), T1 second (08:00).
    const tripIxs = Array.from(tile.stops.S1!.tripIxs);
    expect(tile.stringTable[tile.trips[tripIxs[0]!]!.tripIdIx]).toBe("T2");
    expect(tile.stringTable[tile.trips[tripIxs[1]!]!.tripIdIx]).toBe("T1");

    // Stop S2 also has both trips.
    expect(Array.from(tile.stops.S2!.departureSecs)).toEqual([7 * 3600 + 2100, 8 * 3600 + 300]);

    // Headsign deduped in stringTable: "Downtown" appears once.
    const headsignCount = tile.stringTable.filter((s) => s === "Downtown").length;
    expect(headsignCount).toBe(1);
  });

  it("supports overnight trips with departureSec >= 86400", () => {
    const tile = mkFixture({
      services: [
        { id: "SVC_NIGHT", days: [true, true, true, true, true, true, true] },
      ],
      routes: [{ id: "R_NIGHT", shortName: "N1", mode: "BUS" }],
      trips: [
        {
          tripId: "T_LATE", routeId: "R_NIGHT", serviceId: "SVC_NIGHT", headsign: "Airport",
          stopTimes: [
            { stopId: "S_HUB", departureSec: 25 * 3600 + 30 * 60 }, // 25:30 (next day 01:30)
          ],
        },
      ],
    });

    expect(Array.from(tile.stops.S_HUB!.departureSecs)).toEqual([25 * 3600 + 30 * 60]);
  });

  it("accepts services with `added` / `removed` calendar exceptions", () => {
    const tile = mkFixture({
      services: [
        {
          id: "SVC_HOLIDAY",
          days: [true, true, true, true, true, false, false],
          added: ["20260704"],
          removed: ["20260106"],
        },
      ],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [
        {
          tripId: "T1", routeId: "R1", serviceId: "SVC_HOLIDAY", headsign: "Downtown",
          stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
        },
      ],
    });

    expect(tile.calendar[0]!.added).toEqual(["20260704"]);
    expect(tile.calendar[0]!.removed).toEqual(["20260106"]);
  });

  it("supports multiple routes with distinct colors and modes", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: [true, true, true, true, true, true, true] }],
      routes: [
        { id: "R1", shortName: "1", mode: "BUS", color: "#FF6600" },
        { id: "R2", shortName: "2", mode: "TRAM", color: "#00AA66", subMode: "EXPRESS_TRAM" },
      ],
      trips: [
        {
          tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
        },
        {
          tripId: "T2", routeId: "R2", serviceId: "SVC", headsign: "B",
          stopTimes: [{ stopId: "S1", departureSec: 9 * 3600 }],
        },
      ],
    });

    expect(tile.routes).toHaveLength(2);
    expect(tile.routes[0]!.id).toBe("R1");
    expect(tile.routes[0]!.color).toBe("#FF6600");
    expect(tile.routes[1]!.id).toBe("R2");
    expect(tile.routes[1]!.subMode).toBe("EXPRESS_TRAM");
  });

  it("throws when a trip references an unknown routeId or serviceId", () => {
    expect(() => mkFixture({
      services: [{ id: "SVC", days: [true, true, true, true, true, true, true] }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "MISSING", serviceId: "SVC", headsign: "A",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    })).toThrow(/unknown routeId/i);

    expect(() => mkFixture({
      services: [{ id: "SVC", days: [true, true, true, true, true, true, true] }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "MISSING", headsign: "A",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    })).toThrow(/unknown serviceId/i);
  });
});
