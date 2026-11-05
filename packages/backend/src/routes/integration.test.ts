import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundleManifest } from "@pt/shared";
import type { ManifestSnapshot } from "../gtfs/scheduler.js";
import {
  decodeScheduleTile,
  getDeparturesFromTile,
  SCHEDULE_TILE_SIZE_LABEL,
  scheduleTileCoordAt,
  type DecodedScheduleTile,
} from "@pt/shared";
import { decompressTileBytes } from "../gtfs/scheduleTileBrotli.js";
import { buildAndPublishBundle } from "../gtfs/buildAndPublishBundle.js";
import { createScheduleTileHandler } from "./scheduleTile.js";
import { createGtfsManifestHandler } from "./gtfsManifest.js";
import type { CanonicalStore, ServiceEntry } from "../gtfs/canonical/CanonicalStore.js";
import type { CompactStopTimes } from "../gtfs/parser.js";

function mkSimpleCanonical(): CanonicalStore {
  const stops = new Map([
    ["S1", { id: "S1", name: "Stop One", lat: 54.6892, lon: 25.2798, parentStation: "" }],
  ]);
  const routes = new Map([
    [
      "R1",
      {
        id: "R1",
        shortName: "1",
        longName: "Line",
        mode: "BUS" as const,
        color: "FF6600",
        textColor: "FFFFFF",
      },
    ],
  ]);
  const trips = new Map([
    ["T1", { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
  ]);
  const services = new Map<string, ServiceEntry>([
    [
      "SVC",
      {
        serviceId: "SVC",
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: true,
        startDate: "20260101",
        endDate: "20261231",
        exceptions: new Map(),
      },
    ],
  ]);
  const tripIdsByIx = ["T1"];
  const stopTimes = new Map<string, CompactStopTimes>([
    ["S1", { tripIdIdx: Uint32Array.from([0]), departureSecs: Uint32Array.from([8 * 3600]) }],
  ]);
  return {
    stopCount: 1,
    compactStopTimesCount: 1,
    getCompactStopTimes: (id) => stopTimes.get(id),
    iterCompactStopTimes(cb) {
      for (const [id, ct] of stopTimes) cb(id, ct);
    },
    getTripIdForIx: (ix) => tripIdsByIx[ix],
    internTripStringCount: () => tripIdsByIx.length,
    getStop: (id) => stops.get(id),
    iterStops(cb) {
      for (const [id, s] of stops) cb(id, s);
    },
    getRoute: (id) => routes.get(id),
    iterRoutes(cb) {
      for (const [id, r] of routes) cb(id, r);
    },
    getTrip: (id) => trips.get(id),
    iterTrips(cb) {
      for (const [id, t] of trips) cb(id, t);
    },
    getService: (id) => services.get(id),
    iterServices(cb) {
      for (const [id, s] of services) cb(id, s);
    },
  };
}

describe("PR 3 routes — end-to-end against a PR-2-generated bundle", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ptn-int-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("schedule-tile route returns a tile that decodes to the expected Departure[] via getDeparturesFromTile", async () => {
    const result = await buildAndPublishBundle({
      canonical: mkSimpleCanonical(),
      cityId: "vilnius",
      dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [],
      minTripsPerRoute: 1,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    const app = Fastify({ logger: false });
    app.get(
      "/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords",
      createScheduleTileHandler({
        dataDir,
        getCurrentBundleHash: () => result.bundleHash,
      }),
    );

    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${result.bundleHash}/${SCHEDULE_TILE_SIZE_LABEL}/${cell.x}_${cell.y}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pt-bundle-hash"]).toBe(result.bundleHash);

    const decoded: DecodedScheduleTile = decodeScheduleTile(
      decompressTileBytes(res.rawPayload),
    );
    const now = new Date(2026, 4, 4, 7, 0, 0); // Mon 07:00
    const out = getDeparturesFromTile({
      tile: decoded,
      stopId: "S1",
      now,
      limit: 20,
      lookAheadHours: 2,
    });
    expect(out.serviceState).toBe("active");
    expect(out.departures).toHaveLength(1);
    expect(out.departures[0]!.tripId).toBe("T1");
    expect(out.departures[0]!.routeColor).toBe("#FF6600");
  });

  it("manifest route returns the BundleManifest of the just-built bundle", async () => {
    const result = await buildAndPublishBundle({
      canonical: mkSimpleCanonical(),
      cityId: "vilnius",
      dataDir,
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [],
      minTripsPerRoute: 1,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    // Build a snapshot from the on-disk manifest (mirrors GtfsScheduler.getManifestSnapshot).
    const manifestText = readFileSync(join(dataDir, "manifest.json"), "utf8");
    const manifestParsed = JSON.parse(manifestText) as BundleManifest;
    const manifestSnapshot: ManifestSnapshot = {
      bundleHash: manifestParsed.bundleHash,
      subdivisions: manifestParsed.subdivisions ?? {},
      contentEtag: createHash("sha256").update(manifestText).digest("hex").slice(0, 32),
      parsed: manifestParsed,
    };

    const app = Fastify({ logger: false });
    app.get("/api/gtfs/manifest", createGtfsManifestHandler({
      getManifestSnapshot: () => manifestSnapshot,
    }));

    const res = await app.inject({ method: "GET", url: "/api/gtfs/manifest" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.bundleHash).toBe(result.bundleHash);
    expect(body.tileSize).toBe(6000);
  });
});
