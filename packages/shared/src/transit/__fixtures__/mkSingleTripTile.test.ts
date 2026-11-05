import { describe, it, expect } from "vitest";
import { mkSingleTripTile } from "./mkSingleTripTile.js";
import { SCHEDULE_TILE_EDGE_METERS } from "../../poi/tileParams.js";

describe("mkSingleTripTile", () => {
  it("emits a valid DecodedScheduleTile", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "42",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
    });

    expect(tile.bundleHash).toMatch(/^[0-9a-f]+$/);
    expect(tile.cityId).toBe("test");
    expect(tile.tileSize).toBe(SCHEDULE_TILE_EDGE_METERS);
    expect(tile.routes).toHaveLength(1);
    expect(tile.routes[0]!.id).toBe("R1");
    expect(tile.routes[0]!.shortName).toBe("42");
    expect(tile.routes[0]!.mode).toBe("BUS");
    expect(tile.calendar).toHaveLength(1);
    expect(tile.calendar[0]!.serviceId).toBe("SVC_DAILY");
    expect(tile.calendar[0]!.days).toEqual([true, true, true, true, true, true, true]);
    expect(tile.trips).toHaveLength(1);
    expect(tile.trips[0]!.routeIx).toBe(0);
    expect(tile.trips[0]!.serviceIx).toBe(0);
    expect(tile.stringTable[tile.trips[0]!.tripIdIx]).toBe("T1");
    expect(tile.stringTable[tile.trips[0]!.headsignIx]).toBe("Downtown");
    expect(tile.stops.S1).toBeDefined();
    expect(Array.from(tile.stops.S1!.tripIxs)).toEqual([0]);
    expect(Array.from(tile.stops.S1!.departureSecs)).toEqual([8 * 3600]);
  });

  it("accepts optional `routeColor`, `subMode`, `bundleHash`, `cityId`, `tileSize`", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "42",
      mode: "TRAM",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      subMode: "EXPRESS_BUS",
      bundleHash: "cafef00d",
      cityId: "vilnius",
      tileSize: 8000,
    });

    expect(tile.bundleHash).toBe("cafef00d");
    expect(tile.cityId).toBe("vilnius");
    expect(tile.tileSize).toBe(8000);
    expect(tile.routes[0]!.color).toBe("#FF6600");
    expect(tile.routes[0]!.subMode).toBe("EXPRESS_BUS");
  });

  it("accepts optional date-window overrides", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "42",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      startDate: "20260601",
      endDate: "20260831",
      added: ["20260415"],
      removed: ["20260704"],
    });

    expect(tile.calendar[0]!.startDate).toBe("20260601");
    expect(tile.calendar[0]!.endDate).toBe("20260831");
    expect(tile.calendar[0]!.added).toEqual(["20260415"]);
    expect(tile.calendar[0]!.removed).toEqual(["20260704"]);
  });
});
