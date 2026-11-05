import { describe, it, expect } from "vitest";
import { strToU8 } from "fflate";
import { createStopTimeStreamBuilder } from "./index-builder.js";
import { createOrphanTracker } from "./referentialIntegrity.js";
import type { GtfsTrip } from "./parser.js";

function tripsIndex(ids: string[]): Map<string, GtfsTrip> {
  const m = new Map<string, GtfsTrip>();
  for (const id of ids) {
    m.set(id, { tripId: id, routeId: "r1", serviceId: "svc", headsign: "H", directionId: 0 } as GtfsTrip);
  }
  return m;
}

function stopTimesCsv(rows: { tripId: string; stopId: string; dep: string; seq: number }[]): Uint8Array {
  const header = "trip_id,arrival_time,departure_time,stop_id,stop_sequence";
  const body = rows.map((r) => `${r.tripId},${r.dep},${r.dep},${r.stopId},${r.seq}`);
  return strToU8([header, ...body].join("\n") + "\n");
}

describe("createStopTimeStreamBuilder + orphan tracker", () => {
  it("finish() accepts a feed with zero orphans", async () => {
    const tracker = createOrphanTracker({ threshold: 0.001 });
    const b = createStopTimeStreamBuilder(tripsIndex(["t1", "t2"]), tracker);
    b.beginFeed();
    b.push(stopTimesCsv([
      { tripId: "t1", stopId: "s1", dep: "08:00:00", seq: 1 },
      { tripId: "t2", stopId: "s1", dep: "09:00:00", seq: 1 },
    ]));
    await b.endFeed();
    await expect(b.finish()).resolves.toBeDefined();
    expect(tracker.total).toBe(2);
    expect(tracker.orphan).toBe(0);
  });

  it("finish() rejects feed with orphan ratio > 0.1%", async () => {
    const tracker = createOrphanTracker({ threshold: 0.001 });
    const b = createStopTimeStreamBuilder(tripsIndex(["t1"]), tracker);
    b.beginFeed();
    const rows = [{ tripId: "t1", stopId: "s1", dep: "08:00:00", seq: 1 }];
    for (let i = 0; i < 10; i++) {
      rows.push({ tripId: `orphan_${i}`, stopId: "s2", dep: "08:01:00", seq: 1 });
    }
    b.push(stopTimesCsv(rows));
    await b.endFeed();
    await expect(b.finish()).rejects.toThrow(/orphan|integrity/i);
  });

  it("finish() allows small amounts of orphans below threshold", async () => {
    const tracker = createOrphanTracker({ threshold: 0.001 });
    const b = createStopTimeStreamBuilder(tripsIndex(["t1"]), tracker);
    b.beginFeed();
    const rows: Parameters<typeof stopTimesCsv>[0] = [];
    for (let i = 0; i < 10_000; i++) rows.push({ tripId: "t1", stopId: `s${i}`, dep: "08:00:00", seq: 1 });
    for (let i = 0; i < 5; i++) rows.push({ tripId: `orphan_${i}`, stopId: "sx", dep: "08:00:00", seq: 1 });
    b.push(stopTimesCsv(rows));
    await b.endFeed();
    await expect(b.finish()).resolves.toBeDefined();
    expect(tracker.orphan).toBe(5);
    expect(tracker.total).toBe(10_005);
  });

  it("tracker parameter is optional — omitting it disables the check", async () => {
    const b = createStopTimeStreamBuilder(tripsIndex(["t1"]));
    b.beginFeed();
    b.push(stopTimesCsv([
      { tripId: "orphan1", stopId: "sx", dep: "08:00:00", seq: 1 },
    ]));
    await b.endFeed();
    await expect(b.finish()).resolves.toBeDefined();
  });
});
