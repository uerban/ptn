import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { getStopsNearby, getStopsAll } from "../../src/routes/stops.ts";
import { GtfsStore } from "../../src/gtfs/store.ts";
import { buildIndexes } from "../../src/gtfs/index-builder.ts";

const { indexes, canonical, routingInput } = buildIndexes(
  [
    { id: "s1", name: "Stop A", lat: 54.68, lon: 25.28, parentStation: "" },
    { id: "s2", name: "Stop B", lat: 54.69, lon: 25.29, parentStation: "" },
  ],
  [{ id: "r1", shortName: "1", longName: "L1", mode: "BUS" as const, color: "FF0000", textColor: "FFFFFF" }],
  [{ tripId: "t1", routeId: "r1", serviceId: "svc1", headsign: "X" }],
  [{ tripId: "t1", stopId: "s1", departureTime: "08:00:00", stopSequence: 1 }],
  [{ serviceId: "svc1", monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, startDate: "20250101", endDate: "20271231" }],
  []
);

describe("stop endpoints", () => {
  let app: ReturnType<typeof Fastify>;
  let generationDir: string;

  beforeAll(async () => {
    // labelAnchor is now read from a producer-published label-anchors.json rather than computed
    // in-process, so give the store a real generationDir with a fixture file to read.
    generationDir = mkdtempSync(join(tmpdir(), "ptn-stops-route-test-"));
    writeFileSync(join(generationDir, "label-anchors.json"), JSON.stringify({ s1: "right", s2: "top-left" }));

    app = Fastify();
    const store = new GtfsStore();
    store.swap(indexes, canonical, routingInput, 0, generationDir);
    app.decorate("gtfsStore", store);
    app.get("/api/stops/nearby", getStopsNearby);
    app.get("/api/stops/all", getStopsAll);
    await app.ready();
  });

  afterAll(() => {
    rmSync(generationDir, { recursive: true, force: true });
  });

  it("GET /api/stops/nearby returns stops within radius", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/nearby?lat=54.685&lon=25.285&radius=5000",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].routes).toBeDefined();
  });

  it("GET /api/stops/all returns all stops", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/all",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
  });

  it("GET /api/stops/all carries a precomputed labelAnchor per stop", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stops/all" });
    const body = JSON.parse(res.body);
    const ANCHORS = new Set([
      "right", "top-right", "top", "top-left",
      "left", "bottom-left", "bottom", "bottom-right",
    ]);
    for (const stop of body.data) {
      expect(ANCHORS.has(stop.labelAnchor)).toBe(true);
    }
    // The two fixture stops are ~1.1 km apart (no neighbours) → both default right.
    expect(body.data.find((s: { id: string }) => s.id === "s1").labelAnchor).toBe("right");
  });

  it("GET /api/stops/nearby carries labelAnchor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/nearby?lat=54.685&lon=25.285&radius=5000",
    });
    const body = JSON.parse(res.body);
    expect(body.data[0].labelAnchor).toBeDefined();
  });

  it("returns 400 for missing lat/lon", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/nearby?lat=54.68",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/stops/all?withinHours=24 filters routes to active ones, excludes stops with no active routes", async () => {
    // withinHours=24 ensures the 08:00 departure is always within range
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/all?withinHours=24",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Only s1 returned; s2 has no active routes and is filtered out
    expect(body.data).toHaveLength(1);

    const s1 = body.data.find((s: { id: string }) => s.id === "s1");
    expect(s1.routes).toHaveLength(1);
    expect(s1.routes[0].id).toBe("r1");

    expect(body.data.find((s: { id: string }) => s.id === "s2")).toBeUndefined();
  });

  it("GET /api/stops/all?withinHours=abc returns 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/all?withinHours=abc",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/stops/all?withinHours=0 returns 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/all?withinHours=0",
    });
    expect(res.statusCode).toBe(400);
  });
});
