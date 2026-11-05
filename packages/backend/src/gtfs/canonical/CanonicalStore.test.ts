import { describe, it, expect } from "vitest";
import { createCanonicalStore, type CanonicalBuildInput } from "./CanonicalStore.js";
import type { CompactStopTimes } from "../parser.js";
import { buildTripStringTable } from "../parser.js";

function ct(tripIdIdx: number[], departureSecs: number[]): CompactStopTimes {
  return {
    tripIdIdx: new Uint32Array(tripIdIdx),
    departureSecs: new Uint32Array(departureSecs),
  };
}

function input(overrides: Partial<CanonicalBuildInput> = {}): CanonicalBuildInput {
  return {
    stopTimes: new Map(),
    tripStrings: buildTripStringTable([]),
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    services: new Map(),
    ...overrides,
  };
}

describe("CanonicalStore — CompactStopTimes surface (renamed iterator)", () => {
  it("getCompactStopTimes returns stored value or undefined", () => {
    const store = createCanonicalStore(input({
      stopTimes: new Map([["S1", ct([0], [60])]]),
      tripStrings: buildTripStringTable(["T1"]),
    }));
    expect(store.getCompactStopTimes("S1")?.departureSecs[0]).toBe(60);
    expect(store.getCompactStopTimes("missing")).toBeUndefined();
  });

  it("iterCompactStopTimes yields every (stopId, ct) pair", () => {
    const store = createCanonicalStore(input({
      stopTimes: new Map([
        ["S1", ct([0], [60])],
        ["S2", ct([0], [120])],
      ]),
      tripStrings: buildTripStringTable(["T1"]),
    }));
    const seen: string[] = [];
    store.iterCompactStopTimes((id) => { seen.push(id); });
    expect(seen).toEqual(["S1", "S2"]);
  });

  it("stopCount reflects stops.size; compactStopTimesCount reflects stopTimes.size", () => {
    const store = createCanonicalStore(input({
      stops: new Map([
        ["S1", { id: "S1", name: "A", lat: 0, lon: 0, parentStation: "" }],
        ["S2", { id: "S2", name: "B", lat: 0, lon: 0, parentStation: "" }],
        ["S3", { id: "S3", name: "C", lat: 0, lon: 0, parentStation: "" }],
      ]),
      stopTimes: new Map([
        ["S1", ct([0], [60])],
      ]),
      tripStrings: buildTripStringTable(["T1"]),
    }));
    expect(store.stopCount).toBe(3);
    expect(store.compactStopTimesCount).toBe(1);
  });
});

describe("CanonicalStore — metadata accessors", () => {
  const full = input({
    stops: new Map([
      ["S1", { id: "S1", name: "Stop One", lat: 1, lon: 2, parentStation: "" }],
    ]),
    routes: new Map([
      ["R1", { id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "FF0000", textColor: "FFFFFF" }],
    ]),
    trips: new Map([
      ["T1", { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
    ]),
    services: new Map([
      ["SVC", {
        serviceId: "SVC",
        monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
        startDate: "20260101", endDate: "20261231",
        exceptions: new Map([["20260704", 2]]),
      }],
    ]),
  });

  it("getStop / iterStops round-trip", () => {
    const store = createCanonicalStore(full);
    expect(store.getStop("S1")?.name).toBe("Stop One");
    expect(store.getStop("NOPE")).toBeUndefined();
    const seen: string[] = [];
    store.iterStops((id) => seen.push(id));
    expect(seen).toEqual(["S1"]);
  });

  it("getRoute / iterRoutes round-trip", () => {
    const store = createCanonicalStore(full);
    expect(store.getRoute("R1")?.shortName).toBe("1");
    expect(store.getRoute("NOPE")).toBeUndefined();
    const seen: string[] = [];
    store.iterRoutes((id) => seen.push(id));
    expect(seen).toEqual(["R1"]);
  });

  it("getTrip / iterTrips round-trip", () => {
    const store = createCanonicalStore(full);
    expect(store.getTrip("T1")?.headsign).toBe("Downtown");
    expect(store.getTrip("NOPE")).toBeUndefined();
    const seen: string[] = [];
    store.iterTrips((id) => seen.push(id));
    expect(seen).toEqual(["T1"]);
  });

  it("getService / iterServices round-trip with readonly exceptions", () => {
    const store = createCanonicalStore(full);
    const svc = store.getService("SVC");
    expect(svc?.monday).toBe(true);
    expect(svc?.exceptions.get("20260704")).toBe(2);
    expect(store.getService("NOPE")).toBeUndefined();
    const seen: string[] = [];
    store.iterServices((id) => seen.push(id));
    expect(seen).toEqual(["SVC"]);
  });
});

describe("CanonicalStore — tripStrings accessor", () => {
  it("getTripIdForIx returns the interned string or undefined for out-of-range", () => {
    const tripStrings = buildTripStringTable(["T1", "T2"]);
    const store = createCanonicalStore(input({ tripStrings }));
    expect(store.getTripIdForIx(0)).toBe("T1");
    expect(store.getTripIdForIx(1)).toBe("T2");
    expect(store.getTripIdForIx(-1)).toBeUndefined();
    expect(store.getTripIdForIx(999)).toBeUndefined();
  });

  it("internTripStringCount returns the number of interned trip ids", () => {
    const tripStrings = buildTripStringTable(["T1", "T2", "T3"]);
    const store = createCanonicalStore(input({ tripStrings }));
    expect(store.internTripStringCount()).toBe(3);
  });
});

describe("CanonicalStore — empty-input build", () => {
  it("all accessors handle empty maps without throwing", () => {
    const store = createCanonicalStore(input());
    expect(store.stopCount).toBe(0);
    expect(store.compactStopTimesCount).toBe(0);
    expect(store.getStop("X")).toBeUndefined();
    expect(store.getRoute("X")).toBeUndefined();
    expect(store.getTrip("X")).toBeUndefined();
    expect(store.getService("X")).toBeUndefined();
    expect(store.getTripIdForIx(0)).toBeUndefined();
    const calls: number[] = [];
    store.iterStops(() => calls.push(1));
    store.iterRoutes(() => calls.push(1));
    store.iterTrips(() => calls.push(1));
    store.iterServices(() => calls.push(1));
    store.iterCompactStopTimes(() => calls.push(1));
    expect(calls).toEqual([]);
  });
});

describe("CanonicalStore — iteration reference stability under concurrent swap", () => {
  it("iterStops keeps yielding the original map's values even if a new canonical is created mid-iteration", () => {
    const original = createCanonicalStore(input({
      stops: new Map([
        ["A", { id: "A", name: "Alpha", lat: 0, lon: 0, parentStation: "" }],
        ["B", { id: "B", name: "Bravo", lat: 0, lon: 0, parentStation: "" }],
      ]),
    }));
    const seen: string[] = [];
    original.iterStops((id) => {
      seen.push(id);
      if (seen.length === 1) {
        createCanonicalStore(input({
          stops: new Map([
            ["X", { id: "X", name: "New", lat: 0, lon: 0, parentStation: "" }],
          ]),
        }));
      }
    });
    expect(seen).toEqual(["A", "B"]);
  });
});
