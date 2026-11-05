import { describe, it, expect } from "vitest";
import { groupStopsByCell } from "./groupStopsByCell.js";
import { scheduleTileCoordAt } from "@pt/shared";
import type { GtfsStop } from "./parser.js";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";

function mkCanonical(stops: GtfsStop[]): CanonicalStore {
  // Minimal CanonicalStore stub — only `iterStops` is exercised.
  const stopsMap = new Map(stops.map((s) => [s.id, s] as const));
  return {
    stopCount: stopsMap.size,
    compactStopTimesCount: 0,
    getCompactStopTimes() { return undefined; },
    iterCompactStopTimes() {},
    getTripIdForIx() { return undefined; },
    internTripStringCount() { return 0; },
    getStop(id) { return stopsMap.get(id); },
    iterStops(cb) { for (const [id, s] of stopsMap) cb(id, s); },
    getRoute() { return undefined; },
    iterRoutes() {},
    getTrip() { return undefined; },
    iterTrips() {},
    getService() { return undefined; },
    iterServices() {},
  };
}

describe("groupStopsByCell", () => {
  it("buckets stops at the same coordinates into one cell", () => {
    // Two stops at almost-identical coords should land in the same cell.
    const a: GtfsStop = { id: "A", name: "A", lat: 54.6900, lon: 25.2700, parentStation: "" };
    const b: GtfsStop = { id: "B", name: "B", lat: 54.6901, lon: 25.2701, parentStation: "" };

    const cells = groupStopsByCell(mkCanonical([a, b]));

    const { x, y } = scheduleTileCoordAt(a.lat, a.lon);
    const expectedKey = `${x}_${y}`;
    expect(cells.size).toBe(1);
    expect(cells.has(expectedKey)).toBe(true);
    expect(cells.get(expectedKey)!).toHaveLength(2);
    expect(cells.get(expectedKey)!.map((s) => s.id).sort()).toEqual(["A", "B"]);
  });

  // "Stop on the tile boundary placed in the tile whose `[min, max)` range includes its
  // coordinates." `scheduleTileCoordAt` uses `Math.floor` for both x and y, so a stop exactly on a
  // cell boundary lands in the lower-numbered cell.
  it("places a stop exactly on a cell boundary into the lower-numbered cell (half-open [min, max))", () => {
    // Pick a lat/lon such that `lat / STEP_LAT_DEG` is an integer — that's
    // exactly on a tile boundary. With `STEP_LAT_DEG ≈ 0.054` (6 km schedule
    // grid), the lat 0.0 sits on the boundary between rows -1 and 0;
    // floor(0/step)=0 wins.
    const onBoundary: GtfsStop = { id: "B", name: "B", lat: 0, lon: 0, parentStation: "" };
    const cells = groupStopsByCell(mkCanonical([onBoundary]));
    const onBoundaryCoord = scheduleTileCoordAt(0, 0);
    expect(cells.has(`${onBoundaryCoord.x}_${onBoundaryCoord.y}`)).toBe(true);
    // floor(0 / step) = 0 — the lower-numbered side of the boundary.
    expect(onBoundaryCoord.y).toBe(0);
    expect(onBoundaryCoord.x).toBe(0);
  });

  it("buckets stops at far-apart coordinates into different cells", () => {
    const vilnius: GtfsStop = { id: "V", name: "Vilnius", lat: 54.6892, lon: 25.2798, parentStation: "" };
    const krakow: GtfsStop = { id: "K", name: "Krakow", lat: 50.0647, lon: 19.9450, parentStation: "" };

    const cells = groupStopsByCell(mkCanonical([vilnius, krakow]));

    expect(cells.size).toBe(2);
    const vKey = (() => { const c = scheduleTileCoordAt(vilnius.lat, vilnius.lon); return `${c.x}_${c.y}`; })();
    const kKey = (() => { const c = scheduleTileCoordAt(krakow.lat, krakow.lon); return `${c.x}_${c.y}`; })();
    expect(vKey).not.toBe(kKey);
    expect(cells.get(vKey)).toHaveLength(1);
    expect(cells.get(kKey)).toHaveLength(1);
  });

  it("returns an empty Map when the canonical store has no stops", () => {
    const cells = groupStopsByCell(mkCanonical([]));
    expect(cells.size).toBe(0);
  });

  it("preserves stop iteration order within each cell (callers can rely on it)", () => {
    const a: GtfsStop = { id: "A", name: "A", lat: 54.6900, lon: 25.2700, parentStation: "" };
    const b: GtfsStop = { id: "B", name: "B", lat: 54.6901, lon: 25.2701, parentStation: "" };
    const c: GtfsStop = { id: "C", name: "C", lat: 54.6902, lon: 25.2702, parentStation: "" };

    const cells = groupStopsByCell(mkCanonical([a, b, c]));
    const cellStops = cells.values().next().value!;
    expect(cellStops.map((s) => s.id)).toEqual(["A", "B", "C"]);
  });
});
