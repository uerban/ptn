import { describe, it, expect } from "vitest";
import {
  encodeScheduleTile,
  decodeScheduleTile,
  decodeScheduleTileFromText,
  SCHEDULE_TILE_WIRE_VERSION,
} from "./scheduleTileCodec.js";
import { mkFixture } from "./__fixtures__/mkFixture.js";

const ALL_DAYS = [true, true, true, true, true, true, true] as const;

describe("scheduleTileCodec", () => {
  it("round-trips a single-trip tile to bytes and back to identical decoded form", () => {
    const original = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "#FF6600" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });

    const bytes = encodeScheduleTile(original);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    const decoded = decodeScheduleTile(bytes);
    expect(decoded.bundleHash).toBe(original.bundleHash);
    expect(decoded.cityId).toBe(original.cityId);
    expect(decoded.tileSize).toBe(original.tileSize);
    expect(decoded.stringTable).toEqual([...original.stringTable]);
    expect(decoded.routes).toEqual(original.routes);
    expect(decoded.calendar).toEqual(original.calendar);
    expect(decoded.trips).toEqual(original.trips);
    expect(Object.keys(decoded.stops)).toEqual(Object.keys(original.stops));
    expect(decoded.stops.S1!.tripIxs).toBeInstanceOf(Uint32Array);
    expect(decoded.stops.S1!.departureSecs).toBeInstanceOf(Uint32Array);
    expect(Array.from(decoded.stops.S1!.tripIxs)).toEqual(Array.from(original.stops.S1!.tripIxs));
    expect(Array.from(decoded.stops.S1!.departureSecs)).toEqual(Array.from(original.stops.S1!.departureSecs));
  });

  it("round-trips a multi-trip multi-stop tile", () => {
    const original = mkFixture({
      services: [
        { id: "SVC_DAILY", days: ALL_DAYS },
        { id: "SVC_HOLIDAY", days: ALL_DAYS, added: ["20260704"], removed: ["20260106"] },
      ],
      routes: [
        { id: "R1", shortName: "1", mode: "BUS" },
        { id: "R2", shortName: "2", mode: "TRAM", subMode: "EXPRESS_TRAM", color: "#00AA66" },
      ],
      trips: [
        { tripId: "T1", routeId: "R1", serviceId: "SVC_DAILY", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }, { stopId: "S2", departureSec: 8 * 3600 + 300 }] },
        { tripId: "T2", routeId: "R2", serviceId: "SVC_HOLIDAY", headsign: "B",
          stopTimes: [{ stopId: "S1", departureSec: 9 * 3600 }] },
      ],
    });

    const decoded = decodeScheduleTile(encodeScheduleTile(original));
    expect(decoded.routes).toEqual(original.routes);
    expect(decoded.calendar).toEqual(original.calendar);
    expect(decoded.trips).toEqual(original.trips);
    expect(Array.from(decoded.stops.S1!.tripIxs)).toEqual(Array.from(original.stops.S1!.tripIxs));
    expect(Array.from(decoded.stops.S2!.tripIxs)).toEqual(Array.from(original.stops.S2!.tripIxs));
  });

  it("emits a version-tagged JSON payload (v1)", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "A",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    const bytes = encodeScheduleTile(tile);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);

    expect(parsed.v).toBe(SCHEDULE_TILE_WIRE_VERSION);
    expect(SCHEDULE_TILE_WIRE_VERSION).toBe(1);
    expect(parsed.bundleHash).toBe(tile.bundleHash);
  });

  it("decoder rejects an unknown wire version with a clear error", () => {
    const wrong = new TextEncoder().encode(JSON.stringify({ v: 99, bundleHash: "x" }));
    expect(() => decodeScheduleTile(wrong)).toThrow(/wire version/i);
  });

  it("decoder rejects malformed JSON", () => {
    const garbage = new TextEncoder().encode("not json");
    expect(() => decodeScheduleTile(garbage)).toThrow();
  });

  it("decoder rejects a calendar row with wrong days length", () => {
    // GTFS calendar.txt always has 7 day columns; a non-7 length on the
    // wire is a malformed producer. Without this guard, a 5- or 8-element
    // `days` would silently propagate into a `DaysOfWeek`-typed value that
    // lies about its shape, breaking `serviceActiveForDate` downstream.
    const bad = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        bundleHash: "x",
        cityId: "c",
        tileSize: 12000,
        stringTable: [],
        routes: [],
        trips: [],
        stops: {},
        calendar: [
          {
            serviceId: "S",
            days: [true, false, true],
            startDate: "20260101",
            endDate: "20261231",
            added: [],
            removed: [],
          },
        ],
      }),
    );
    expect(() => decodeScheduleTile(bad)).toThrow(/days has length 3/);
  });

  it("decoder rejects per-stop parallel arrays with mismatched lengths", () => {
    // The shape guard (Array.isArray) and the length-equality guard are
    // distinct branches. A regression that dropped only the length check
    // would let `[0, 1]` / `[28800]` through, producing a `Uint32Array`
    // with a phantom 0 in the trailing slot — i.e., a 00:00:00 departure
    // appearing where the producer never emitted one.
    const bad = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        bundleHash: "x",
        cityId: "c",
        tileSize: 12000,
        stringTable: [],
        routes: [],
        trips: [],
        calendar: [],
        stops: { S1: { tripIxs: [0, 1], departureSecs: [28800] } },
      }),
    );
    expect(() => decodeScheduleTile(bad)).toThrow(/parallel arrays.*mismatched lengths/i);
  });

  it("decodeScheduleTileFromText produces the same DecodedScheduleTile as decodeScheduleTile", () => {
    // Pins the delegation: a future refactor that re-implements
    // decodeScheduleTile inline (instead of forwarding to the text version)
    // would break this assertion. Without it, the byte path's existing tests
    // still pass while the text overload silently rots.
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS" }],
      trips: [
        {
          tripId: "T1",
          routeId: "R1",
          serviceId: "SVC",
          headsign: "Downtown",
          stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
        },
      ],
    });
    const bytes = encodeScheduleTile(tile);
    const text = new TextDecoder().decode(bytes);
    const fromBytes = decodeScheduleTile(bytes);
    const fromText = decodeScheduleTileFromText(text);
    expect(fromText.bundleHash).toBe(fromBytes.bundleHash);
    expect(fromText.stringTable).toEqual(fromBytes.stringTable);
    expect(fromText.calendar).toEqual(fromBytes.calendar);
    expect(Array.from(fromText.stops.S1!.departureSecs)).toEqual(
      Array.from(fromBytes.stops.S1!.departureSecs),
    );
  });

  it("decoder rejects malformed per-stop columns", () => {
    // A stop entry where `tripIxs` is not an array would otherwise fall
    // through to `Uint32Array.from(undefined)` (opaque TypeError) or
    // `Uint32Array.from("hello")` (silent zero-padded array). The decoder
    // names the offending stopId so the error is actionable.
    const bad = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        bundleHash: "x",
        cityId: "c",
        tileSize: 12000,
        stringTable: [],
        routes: [],
        trips: [],
        calendar: [],
        stops: {
          BAD_STOP: { tripIxs: "not-an-array", departureSecs: [] },
        },
      }),
    );
    expect(() => decodeScheduleTile(bad)).toThrow(/BAD_STOP.*malformed/i);
  });
});
