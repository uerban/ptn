import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "../../src/db/index.ts";
import { syncGtfsData } from "../../src/services/gtfsSync.ts";
import { api } from "../../src/services/api.ts";
import { resetQuotaGuardForSync } from "../../src/services/gtfsQuotaGuard.ts";
import * as gtfsBundleModule from "../../src/services/gtfsBundle.ts";
import * as errorReporter from "../../src/services/errorReporter.ts";
import {
  installPtbCatalogFetch,
  ptbCatalogState,
  resetPtbCatalogState,
} from "../helpers/ptbCatalog.ts";

// The catalog is PTB bytes now; the decode is stubbed so each case can hand
// `syncGtfsData` the wire object whose shapes behaviour it wants to exercise.
vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
  const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
  return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
});

const BASIC = {
  stops: [{ id: "A", name: "A", lat: 0, lon: 0 }, { id: "B", name: "B", lat: 0, lon: 0 }],
  routes: [{
    id: "R1", shortName: "1", mode: "BUS" as const, stopIds: ["A", "B"],
    trips: [{
      tripId: "T1", serviceId: "S", headsign: "", departureSecs: [0, 60], shapeId: "SHP",
    }],
  }],
  calendar: [],
  meta: {
    generatedAt: "2026-04-22T00:00:00Z", cityId: "vilnius",
    shapesArtifact: { url: "/api/vilnius/gtfs/shapes/shapes-abc.json", hash: "abc", sizeBytes: 42 },
  },
};

beforeEach(async () => {
  // Vitest 4 hands back the existing spy when a method is spied again, so
  // restore between cases or fetchShapesArtifact's call count carries over.
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
  resetQuotaGuardForSync();
  (navigator as any).storage = { estimate: async () => ({ usage: 1, quota: 10 }) };
  resetPtbCatalogState();
  installPtbCatalogFetch();
});

describe("gtfsSync — shapes", () => {
  it("successful sync writes trips+shapes in one transaction", async () => {
    ptbCatalogState.wire = BASIC;
    vi.spyOn(api, "fetchShapesArtifact").mockResolvedValue({
      shapes: [{ shapeId: "SHP", encodedPolyline: "_p~iF~ps|U_ulLnnqC", source: "gtfs" }],
      hash: "abc",
    });
    await syncGtfsData("vilnius");
    expect((await db.gtfsTrips.get("T1"))?.shapeId).toBe("SHP");
    expect((await db.gtfsShapes.get("SHP"))?.encodedPolyline).toBeTruthy();
  });

  it("fetch failure → shapeId stripped, trips commit, one error log", async () => {
    ptbCatalogState.wire = BASIC;
    vi.spyOn(api, "fetchShapesArtifact").mockRejectedValue(new Error("404"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await syncGtfsData("vilnius");
    expect((await db.gtfsTrips.get("T1"))?.shapeId).toBeUndefined();
    expect(await db.gtfsShapes.count()).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("hash mismatch → shapeId stripped", async () => {
    ptbCatalogState.wire = BASIC;
    vi.spyOn(api, "fetchShapesArtifact").mockResolvedValue({ shapes: [], hash: "WRONG" });
    await syncGtfsData("vilnius");
    expect((await db.gtfsTrips.get("T1"))?.shapeId).toBeUndefined();
  });

  it("quota guard false → skip shapes, strip shapeId, one warn", async () => {
    ptbCatalogState.wire = BASIC;
    (navigator as any).storage = { estimate: async () => ({ usage: 9, quota: 10 }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncGtfsData("vilnius");
    expect((await db.gtfsTrips.get("T1"))?.shapeId).toBeUndefined();
    expect(await db.gtfsShapes.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("writeGtfsBundle failure reports error, leaves legacy tables intact, clears stale blob", async () => {
    // Seed a stale blob that would otherwise persist past a failed overwrite
    // and serve old data to the blob-first read path.
    await db.gtfsBundle.put({
      cityId: "vilnius",
      compressedBytes: new ArrayBuffer(0),
      format: "gzip",
      bundleGeneratedAt: "1970-01-01T00:00:00Z",
      compressedSize: 0,
      decompressedSize: 0,
      writtenAt: 0,
    });

    ptbCatalogState.wire = BASIC;
    vi.spyOn(api, "fetchShapesArtifact").mockResolvedValue({
      shapes: [{ shapeId: "SHP", encodedPolyline: "_p~iF~ps|U_ulLnnqC", source: "gtfs" }],
      hash: "abc",
    });
    const writeSpy = vi
      .spyOn(gtfsBundleModule, "writeGtfsBundle")
      .mockRejectedValueOnce(new Error("boom"));
    const reportSpy = vi.spyOn(errorReporter, "reportError").mockImplementation(() => {});

    await syncGtfsData("vilnius");

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(reportSpy.mock.calls[0][1]?.context).toMatchObject({
      where: "gtfsSync.writeGtfsBundle",
      cityId: "vilnius",
    });

    // Legacy fallback is intact.
    expect((await db.gtfsTrips.get("T1"))?.shapeId).toBe("SHP");
    expect((await db.gtfsShapes.get("SHP"))?.encodedPolyline).toBeTruthy();

    // Stale blob was evicted so the read path doesn't serve 1970 data.
    expect(await db.gtfsBundle.get("vilnius")).toBeUndefined();

    reportSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("no shapesArtifact in manifest → no fetch", async () => {
    const noShapes = {
      ...BASIC,
      meta: { ...BASIC.meta, shapesArtifact: undefined },
      routes: [{ ...BASIC.routes[0], trips: [{ ...BASIC.routes[0].trips[0], shapeId: undefined }] }],
    };
    ptbCatalogState.wire = noShapes;
    const spy = vi.spyOn(api, "fetchShapesArtifact");
    await syncGtfsData("vilnius");
    expect(spy).not.toHaveBeenCalled();
  });
});
