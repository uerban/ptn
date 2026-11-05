import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAndPublishBundle } from "./buildAndPublishBundle.js";
import { decompressTileBytes } from "./scheduleTileBrotli.js";
import {
  decodeScheduleTile, getDeparturesFromTile, SCHEDULE_TILE_SIZE_LABEL,
  type BundleManifest,
} from "@pt/shared";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { CompactStopTimes } from "./parser.js";

function mkSimpleCanonical(): CanonicalStore {
  const stops = new Map([
    ["S1", { id: "S1", name: "Stop One", lat: 54.6892, lon: 25.2798, parentStation: "" }],
  ]);
  const routes = new Map([
    ["R1", { id: "R1", shortName: "1", longName: "Line", mode: "BUS" as const, color: "FF6600", textColor: "FFFFFF" }],
  ]);
  const trips = new Map([
    ["T1", { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
  ]);
  const services = new Map<string, ServiceEntry>([[
    "SVC",
    {
      serviceId: "SVC",
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true,
      startDate: "20260101", endDate: "20261231",
      exceptions: new Map(),
    },
  ]]);
  const tripIdsByIx = ["T1"];
  const stopTimes = new Map<string, CompactStopTimes>([[
    "S1",
    { tripIdIdx: Uint32Array.from([0]), departureSecs: Uint32Array.from([8 * 3600]) },
  ]]);
  return {
    stopCount: 1, compactStopTimesCount: 1,
    getCompactStopTimes: (id) => stopTimes.get(id),
    iterCompactStopTimes(cb) { for (const [id, ct] of stopTimes) cb(id, ct); },
    getTripIdForIx: (ix) => tripIdsByIx[ix],
    internTripStringCount: () => tripIdsByIx.length,
    getStop: (id) => stops.get(id),
    iterStops(cb) { for (const [id, s] of stops) cb(id, s); },
    getRoute: (id) => routes.get(id),
    iterRoutes(cb) { for (const [id, r] of routes) cb(id, r); },
    getTrip: (id) => trips.get(id),
    iterTrips(cb) { for (const [id, t] of trips) cb(id, t); },
    getService: (id) => services.get(id),
    iterServices(cb) { for (const [id, s] of services) cb(id, s); },
  };
}

describe("buildAndPublishBundle (end-to-end)", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-e2e-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("produces a bundle whose tiles round-trip through the shared decoder + getDeparturesFromTile", async () => {
    const result = await buildAndPublishBundle({
      canonical: mkSimpleCanonical(),
      cityId: "vilnius",
      dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [],
      minTripsPerRoute: 1,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
      generatedAt: 1700000000000,
    });

    expect(result.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tilesWritten).toBe(1);
    expect(result.janitor.kept).toEqual([result.bundleHash]);
    expect(result.janitor.deleted).toEqual([]);

    const manifest: BundleManifest = JSON.parse(
      readFileSync(join(dataDir, "manifest.json"), "utf8"),
    );
    expect(manifest.bundleHash).toBe(result.bundleHash);
    expect(manifest.generatedAt).toBe(1700000000000);

    const tileDir = join(dataDir, result.bundleHash, SCHEDULE_TILE_SIZE_LABEL);
    const [tileFile] = readdirSync(tileDir).filter((f) => f.endsWith(".br"));
    const decoded = decodeScheduleTile(decompressTileBytes(readFileSync(join(tileDir, tileFile))));

    const now = new Date(2026, 4, 4, 7, 0, 0); // Mon 07:00
    const out = getDeparturesFromTile({
      tile: decoded, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });
    expect(out.serviceState).toBe("active");
    expect(out.departures).toHaveLength(1);
    expect(out.departures[0]!.tripId).toBe("T1");
    expect(out.departures[0]!.routeColor).toBe("#FF6600");
  });

  it("on second invocation with the same inputs, produces an identical bundleHash and the janitor keeps both 'first' and 'second' bundles when keepBundleCount=2", async () => {
    const opts = {
      canonical: mkSimpleCanonical(),
      cityId: "vilnius",
      dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [],
      minTripsPerRoute: 1,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    };

    const first = await buildAndPublishBundle(opts);
    const second = await buildAndPublishBundle(opts);

    expect(first.bundleHash).toBe(second.bundleHash);
    expect(readdirSync(dataDir).filter((n) => /^[0-9a-f]{64}$/.test(n))).toEqual([first.bundleHash]);
  });

  it("when feedFiles change, produces a different bundleHash and the janitor evicts the oldest", async () => {
    const first = await buildAndPublishBundle({
      canonical: mkSimpleCanonical(),
      cityId: "vilnius", dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [], minTripsPerRoute: 1,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await buildAndPublishBundle({
      canonical: mkSimpleCanonical(),
      cityId: "vilnius", dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "b".repeat(64) }],
      rtFeedUrls: [], minTripsPerRoute: 1,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    expect(first.bundleHash).not.toBe(second.bundleHash);

    const onDisk = readdirSync(dataDir).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort();
    expect(onDisk).toEqual([first.bundleHash, second.bundleHash].sort());

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const third = await buildAndPublishBundle({
      canonical: mkSimpleCanonical(),
      cityId: "vilnius", dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "c".repeat(64) }],
      rtFeedUrls: [], minTripsPerRoute: 1,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    const onDiskAfter = readdirSync(dataDir).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort();
    expect(onDiskAfter).toEqual([second.bundleHash, third.bundleHash].sort());
    expect(onDiskAfter).not.toContain(first.bundleHash);
  });

  it("subdivides an over-cap cell end-to-end: manifest carries the plan, result carries stats", async () => {
    const { scheduleCellBounds } = await import("@pt/shared");
    const b = scheduleCellBounds(906, 28);
    const qLat = (b.maxLat - b.minLat) / 4, qLon = (b.maxLon - b.minLon) / 4;
    const stops = new Map<string, any>();
    const stopTimes = new Map<string, CompactStopTimes>();
    for (let i = 0; i < 4; i++) {
      const north = i >= 2, east = i % 2 === 1;
      const id = `P${i}`;
      stops.set(id, { id, name: id, lat: b.minLat + (north ? 3 : 1) * qLat, lon: b.minLon + (east ? 3 : 1) * qLon, parentStation: "" });
      stopTimes.set(id, { tripIdIdx: Uint32Array.from([0]), departureSecs: Uint32Array.from([8 * 3600 + i]) });
    }
    const routes = new Map([["R1", { id: "R1", shortName: "1", longName: "Line", mode: "BUS" as const, color: "FF6600", textColor: "FFFFFF" }]]);
    const trips = new Map([["T1", { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }]]);
    const services = new Map<string, ServiceEntry>([["SVC", { serviceId: "SVC", monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, startDate: "20260101", endDate: "20261231", exceptions: new Map() }]]);
    const tripIdsByIx = ["T1"];
    const canonical: CanonicalStore = {
      stopCount: stops.size, compactStopTimesCount: stopTimes.size,
      getCompactStopTimes: (id) => stopTimes.get(id),
      iterCompactStopTimes(cb) { for (const [id, ct] of stopTimes) cb(id, ct); },
      getTripIdForIx: (ix) => tripIdsByIx[ix],
      internTripStringCount: () => tripIdsByIx.length,
      getStop: (id) => stops.get(id),
      iterStops(cb) { for (const [id, s] of stops) cb(id, s); },
      getRoute: (id) => routes.get(id),
      iterRoutes(cb) { for (const [id, r] of routes) cb(id, r); },
      getTrip: (id) => trips.get(id),
      iterTrips(cb) { for (const [id, t] of trips) cb(id, t); },
      getService: (id) => services.get(id),
      iterServices(cb) { for (const [id, s] of services) cb(id, s); },
    };

    const result = await buildAndPublishBundle({
      canonical, cityId: "paris", dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [], minTripsPerRoute: 1,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
      maxCompressedTileBytes: 120,
    });

    expect(result.stats.subdividedCells).toBe(1);
    const manifest: BundleManifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.subdivisions!["906_28"]!.leaves.length).toBeGreaterThan(1);
  });

  it("rejects keepBundleCount < 1 to prevent dangling-manifest corruption", async () => {
    // Without this guard, keepBundleCount=0 lets the janitor delete the
    // just-written bundle, leaving manifest.json pointing at a missing dir
    // until the next build. The orchestrator must always retain at least
    // the bundle it just wrote. The sync `throw` atop the now-async function
    // surfaces as a rejected promise.
    await expect(
      buildAndPublishBundle({
        canonical: mkSimpleCanonical(),
        cityId: "vilnius",
        dataDir,
        feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
        rtFeedUrls: [],
        minTripsPerRoute: 1,
        resolveRouteColor: () => undefined,
        resolveRouteSubMode: () => undefined,
        keepBundleCount: 0,
      }),
    ).rejects.toThrow(/keepBundleCount must be >= 1/);
  });
});
