import { describe, it, expect } from "vitest";
import { GtfsStore } from "../../src/gtfs/store.js";
import { buildIndexes } from "../../src/gtfs/index-builder.js";
import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
} from "../../src/gtfs/parser.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const stops: GtfsStop[] = [
  { id: "s1", name: "Stop A", lat: 54.68, lon: 25.28, parentStation: "" },
];

const routes: GtfsRoute[] = [
  { id: "r1", shortName: "1", longName: "Line 1", mode: "BUS" as const, color: "FF0000", textColor: "FFFFFF" },
  { id: "r2", shortName: "3", longName: "Line 3", mode: "TRAM" as const, color: "0000FF", textColor: "FFFFFF" },
];

const trips: GtfsTrip[] = [
  { tripId: "t1", routeId: "r1", serviceId: "svc1", headsign: "Centre" },
  { tripId: "t2", routeId: "r1", serviceId: "svc1", headsign: "Centre" },
  { tripId: "t3", routeId: "r2", serviceId: "svc1", headsign: "Station" },
];

const stopTimes: GtfsStopTime[] = [
  { tripId: "t1", stopId: "s1", departureTime: "08:00:00", stopSequence: 1 },
  { tripId: "t2", stopId: "s1", departureTime: "08:30:00", stopSequence: 1 },
  { tripId: "t3", stopId: "s1", departureTime: "09:00:00", stopSequence: 1 },
];

const services: GtfsService[] = [
  {
    serviceId: "svc1",
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false,
    sunday: false,
    startDate: "20250101",
    endDate: "20271231",
  },
];

function makeStore(): GtfsStore {
  const { indexes, canonical, routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
  return new GtfsStore(indexes, canonical, routingInput);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getRealtimeByRoute", () => {
  it("groups RT updates by routeId", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["t2", { delaySeconds: 120, cancelled: false }],
        ["t3", { delaySeconds: -30, cancelled: true }],
      ]),
    );

    const byRoute = store.getRealtimeByRoute();

    expect(byRoute.size).toBe(2);

    const r1Updates = byRoute.get("r1")!;
    expect(r1Updates).toHaveLength(2);
    expect(r1Updates.map((u) => u.tripId).sort()).toEqual(["t1", "t2"]);
    expect(r1Updates.find((u) => u.tripId === "t1")!.delaySeconds).toBe(60);

    const r2Updates = byRoute.get("r2")!;
    expect(r2Updates).toHaveLength(1);
    expect(r2Updates[0].tripId).toBe("t3");
    expect(r2Updates[0].cancelled).toBe(true);
  });

  it("skips date-scoped keys (containing |) to avoid duplicates", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["t1|20250602", { delaySeconds: 60, cancelled: false }],
      ]),
    );

    const byRoute = store.getRealtimeByRoute();
    const r1Updates = byRoute.get("r1")!;
    // Only the bare key should be included, not the date-scoped one
    expect(r1Updates).toHaveLength(1);
    expect(r1Updates[0].tripId).toBe("t1");
  });

  it("skips trips not found in the trip index", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["unknown_trip", { delaySeconds: 10, cancelled: false }],
      ]),
    );

    const byRoute = store.getRealtimeByRoute();
    expect(byRoute.size).toBe(1);
    expect(byRoute.has("r1")).toBe(true);
  });

  it("returns empty map when no RT updates", () => {
    const store = makeStore();
    const byRoute = store.getRealtimeByRoute();
    expect(byRoute.size).toBe(0);
  });

  it("returns empty map when store has no indexes", () => {
    const store = new GtfsStore();
    store.setRealtimeUpdates(
      new Map([["t1", { delaySeconds: 60, cancelled: false }]]),
    );
    const byRoute = store.getRealtimeByRoute();
    expect(byRoute.size).toBe(0);
  });
});

describe("getRealtimeForRoute", () => {
  it("returns updates for a specific route", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["t2", { delaySeconds: 120, cancelled: false }],
        ["t3", { delaySeconds: -30, cancelled: true }],
      ]),
    );

    const r1Updates = store.getRealtimeForRoute("r1");
    expect(r1Updates).toHaveLength(2);
    expect(r1Updates.map((u) => u.tripId).sort()).toEqual(["t1", "t2"]);

    const r2Updates = store.getRealtimeForRoute("r2");
    expect(r2Updates).toHaveLength(1);
    expect(r2Updates[0].tripId).toBe("t3");
  });

  it("returns empty array for unknown route", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([["t1", { delaySeconds: 60, cancelled: false }]]),
    );

    const updates = store.getRealtimeForRoute("nonexistent");
    expect(updates).toEqual([]);
  });

  it("skips date-scoped keys", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["t1|20250602", { delaySeconds: 60, cancelled: false }],
      ]),
    );

    const updates = store.getRealtimeForRoute("r1");
    expect(updates).toHaveLength(1);
  });

  it("returns empty array when store has no indexes", () => {
    const store = new GtfsStore();
    store.setRealtimeUpdates(
      new Map([["t1", { delaySeconds: 60, cancelled: false }]]),
    );
    const updates = store.getRealtimeForRoute("r1");
    expect(updates).toEqual([]);
  });
});

describe("getRealtimeTripUpdates", () => {
  it("returns un-grouped, generation-gated, |-skipped RT", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["t2|20260623", { delaySeconds: 0, cancelled: true }], // date-scoped: must be skipped
      ]),
    );
    const out = store.getRealtimeTripUpdates();
    expect(out).toContainEqual({ tripId: "t1", delaySeconds: 60, cancelled: false });
    expect(out.some((u) => u.tripId.includes("|"))).toBe(false);
  });

  it("enumerates RT without an index (index-free, C4-survivable seam)", () => {
    const store = new GtfsStore();
    store.setRealtimeUpdates(
      new Map([["t1", { delaySeconds: 30, cancelled: false }]]),
    );
    const out = store.getRealtimeTripUpdates();
    expect(out).toEqual([{ tripId: "t1", delaySeconds: 30, cancelled: false }]);
  });
});

describe("setRealtimeUpdates generation-map hygiene", () => {
  const genMapSize = (store: GtfsStore): number =>
    (store as unknown as { realtimeGenerations: Map<string, number> })
      .realtimeGenerations.size;

  it("does not accumulate keys from previous polls (date-scoped key churn)", () => {
    const store = makeStore();
    // Simulate successive service days: each poll carries a fresh date-scoped
    // key set. Before the fix, realtimeGenerations kept every key ever seen.
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 60, cancelled: false }],
        ["t1|20260701", { delaySeconds: 60, cancelled: false }],
        ["t2|20260701", { delaySeconds: 0, cancelled: true }],
      ]),
    );
    expect(genMapSize(store)).toBe(3);
    store.setRealtimeUpdates(
      new Map([
        ["t1", { delaySeconds: 30, cancelled: false }],
        ["t1|20260702", { delaySeconds: 30, cancelled: false }],
      ]),
    );
    expect(genMapSize(store)).toBe(2);
    store.setRealtimeUpdates(new Map());
    expect(genMapSize(store)).toBe(0);
  });

  it("keeps generation gating intact: entries written before a swap stay invisible until re-polled", () => {
    const store = makeStore();
    store.setRealtimeUpdates(
      new Map([["t1", { delaySeconds: 60, cancelled: false }]]),
    );
    expect(store.getRtUpdate("t1")).toEqual({ delaySeconds: 60, cancelled: false });
    (store as unknown as { bumpRealtimeGeneration(): void }).bumpRealtimeGeneration();
    // Stale (pre-swap) entry must be invisible…
    expect(store.getRtUpdate("t1")).toBeUndefined();
    expect(store.rtEntriesForTrip("t1")).toEqual([]);
    // …until the next poll re-tags it with the current generation.
    store.setRealtimeUpdates(
      new Map([["t1", { delaySeconds: 45, cancelled: false }]]),
    );
    expect(store.getRtUpdate("t1")).toEqual({ delaySeconds: 45, cancelled: false });
  });
});
