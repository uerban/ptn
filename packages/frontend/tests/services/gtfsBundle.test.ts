import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/index.ts";
import {
  encodeGzipJson,
  decodeGzipJson,
  readGtfsBundle,
  writeGtfsBundle,
  type RaptorBundleWire,
} from "../../src/services/gtfsBundle.ts";

beforeEach(async () => {
  await db.delete();
  await db.open();
});

function makeWire(): RaptorBundleWire {
  return {
    version: 1,
    meta: { generatedAt: "2026-04-22T00:00:00Z" },
    routes: [
      {
        id: "r1",
        shortName: "1",
        mode: "BUS",
        color: "ff0000",
        textColor: "ffffff",
        stopIds: ["s1", "s2", "s3"],
        trips: [
          {
            tripId: "t1",
            serviceId: "svc1",
            headsign: "Centre",
            departureSecs: [28800, 29400, 30000],
          },
        ],
      },
    ],
    calendar: [
      {
        serviceId: "svc1",
        days: [true, true, true, true, true, false, false],
        startDate: "20260101",
        endDate: "20271231",
        exceptions: {},
      },
    ],
    stops: [
      { id: "s1", name: "Stop 1", lat: 54.0, lon: 25.0 },
      { id: "s2", name: "Stop 2", lat: 54.1, lon: 25.1 },
      { id: "s3", name: "Stop 3", lat: 54.2, lon: 25.2 },
    ],
  };
}

describe("gtfsBundle gzip codec", () => {
  it("round-trips JSON through gzip losslessly", async () => {
    const wire = makeWire();
    const { compressed, decompressedSize } = await encodeGzipJson(wire);
    expect(compressed.byteLength).toBeGreaterThan(0);
    expect(compressed.byteLength).toBeLessThan(decompressedSize);
    const decoded = await decodeGzipJson<RaptorBundleWire>(compressed);
    expect(decoded).toEqual(wire);
  });

  it("compresses JSON to less than raw byte size", async () => {
    // Compression has to actually compress for there to be a point. If the
    // ratio ever inverts on a realistic bundle shape something is badly wrong.
    const big: RaptorBundleWire = {
      ...makeWire(),
      routes: Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`,
        shortName: String(i),
        mode: "BUS",
        stopIds: Array.from({ length: 30 }, (_, j) => `s${i}-${j}`),
        trips: Array.from({ length: 40 }, (_, j) => ({
          tripId: `t${i}-${j}`,
          serviceId: "svc1",
          headsign: "Repeat",
          departureSecs: Array.from({ length: 30 }, (_, k) => 28800 + k * 60),
        })),
      })),
    };
    const { compressed, decompressedSize } = await encodeGzipJson(big);
    // Realistic GTFS-shaped data should compress well (~2–5x) due to high
    // redundancy in stop/service IDs and monotonic time arrays.
    expect(compressed.byteLength).toBeLessThan(decompressedSize / 2);
  });
});

describe("gtfsBundle IDB round-trip", () => {
  it("writes a bundle and reads it back equal", async () => {
    const wire = makeWire();
    const { compressedSize, decompressedSize } = await writeGtfsBundle("vilnius", wire);
    expect(compressedSize).toBeGreaterThan(0);
    expect(decompressedSize).toBeGreaterThan(compressedSize);

    const back = await readGtfsBundle("vilnius");
    expect(back).toEqual(wire);
  });

  it("returns null when no bundle is stored", async () => {
    const back = await readGtfsBundle("vilnius");
    expect(back).toBeNull();
  });

  it("returns null for an unknown format (forward-compat)", async () => {
    const wire = makeWire();
    const { compressed } = await encodeGzipJson(wire);
    await db.gtfsBundle.put({
      cityId: "vilnius",
      compressedBytes: compressed,
      format: "br" as const,
      bundleGeneratedAt: wire.meta.generatedAt,
      compressedSize: compressed.byteLength,
      decompressedSize: 0,
      writtenAt: Date.now(),
    });
    const back = await readGtfsBundle("vilnius");
    expect(back).toBeNull();
  });

  it("returns null for a corrupt blob rather than throwing", async () => {
    const junk = new ArrayBuffer(8);
    new Uint8Array(junk).set([1, 2, 3, 4, 5, 6, 7, 8]);
    await db.gtfsBundle.put({
      cityId: "vilnius",
      compressedBytes: junk,
      format: "gzip",
      bundleGeneratedAt: "2026-04-22T00:00:00Z",
      compressedSize: junk.byteLength,
      decompressedSize: 0,
      writtenAt: Date.now(),
    });
    const back = await readGtfsBundle("vilnius");
    expect(back).toBeNull();
  });

  it("overwrites a previous blob with put semantics", async () => {
    const a = makeWire();
    await writeGtfsBundle("vilnius", a);
    const b: RaptorBundleWire = { ...a, meta: { generatedAt: "2026-05-01T00:00:00Z" } };
    await writeGtfsBundle("vilnius", b);
    const back = await readGtfsBundle("vilnius");
    expect(back?.meta.generatedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("round-trips per-route directionPatterns through gzip+IDB", async () => {
    // A property dropped in `RaptorBundleWire` (frontend) or in
    // `RoutingBundleData` (shared) would silently break the line-preview
    // map for bidirectional routes. Roundtrip a route with a
    // representative two-direction layout through encode → write → read.
    const wire: RaptorBundleWire = {
      ...makeWire(),
      version: 1,
      routes: [{
        ...makeWire().routes[0],
        id: "r69",
        directionPatterns: [
          { key: "0", headsign: "Lazdynėliai", stopIds: ["s1", "s2", "s3"] },
          { key: "1", headsign: "Centras",     stopIds: ["s3", "s2-back", "s1"] },
        ],
      }],
    };
    await writeGtfsBundle("vilnius", wire);
    const back = await readGtfsBundle("vilnius");
    expect(back?.routes[0]?.directionPatterns).toEqual([
      { key: "0", headsign: "Lazdynėliai", stopIds: ["s1", "s2", "s3"] },
      { key: "1", headsign: "Centras",     stopIds: ["s3", "s2-back", "s1"] },
    ]);
  });

  it("round-trips frequencies and PTB trip ordinals through gzip+IDB", async () => {
    const wire: RaptorBundleWire = {
      ...makeWire(),
      frequencies: [
        { tripIdx: 7, startSecs: 21600, endSecs: 86400, headwaySecs: 600, exactTimes: 0 },
      ],
      routes: [{
        ...makeWire().routes[0],
        trips: [{
          ...makeWire().routes[0]!.trips[0]!,
          ptbTripIdx: 7,
        }],
      }],
    };

    await writeGtfsBundle("vilnius", wire);
    const back = await readGtfsBundle("vilnius");
    expect(back?.frequencies).toEqual(wire.frequencies);
    expect(back?.routes[0]?.trips[0]?.ptbTripIdx).toBe(7);
  });
});
