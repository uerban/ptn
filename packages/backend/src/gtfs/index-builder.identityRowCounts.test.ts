import { describe, it, expect } from "vitest";
import { strToU8 } from "fflate";
import { createStopTimeStreamBuilder } from "./index-builder.js";
import { buildCappedTripStringTable } from "./parser.js";
import type { GtfsTrip } from "./parser.js";

function tripsIndex(ids: string[]): Map<string, GtfsTrip> {
  const m = new Map<string, GtfsTrip>();
  for (const id of ids) {
    m.set(id, { tripId: id, routeId: "r1", serviceId: "svc", headsign: "H", directionId: 0 } as unknown as GtfsTrip);
  }
  return m;
}

function csv(rows: { tripId: string; stopId: string; dep: string; seq: number }[]): Uint8Array {
  const header = "trip_id,arrival_time,departure_time,stop_id,stop_sequence";
  const body = rows.map((r) => `${r.tripId},${r.dep},${r.dep},${r.stopId},${r.seq}`);
  return strToU8([header, ...body].join("\n") + "\n");
}

describe("createStopTimeStreamBuilder — prebuilt tripStrings", () => {
  it("uses the prebuilt tripStrings when provided (by reference)", async () => {
    const trips = tripsIndex(["t1", "t2"]);
    const prebuilt = buildCappedTripStringTable(Array.from(trips.keys()), 100);
    const b = createStopTimeStreamBuilder(trips, undefined, prebuilt);
    b.beginFeed();
    b.push(csv([{ tripId: "t1", stopId: "s1", dep: "08:00:00", seq: 1 }]));
    await b.endFeed();
    const result = await b.finish();
    expect(result.tripStrings).toBe(prebuilt);
  });

  it("builds tripStrings internally when no prebuilt is passed (back-compat)", async () => {
    const trips = tripsIndex(["t1"]);
    const b = createStopTimeStreamBuilder(trips);
    b.beginFeed();
    b.push(csv([{ tripId: "t1", stopId: "s1", dep: "08:00:00", seq: 1 }]));
    await b.endFeed();
    const result = await b.finish();
    expect(result.tripStrings).toBeDefined();
    expect(result.tripStrings.indexOf("t1")).toBe(0);
  });
});

describe("createStopTimeStreamBuilder — per-stop / per-trip row counts", () => {
  it("exposes accurate per-stop and per-trip row counts", async () => {
    const trips = tripsIndex(["t1", "t2"]);
    const b = createStopTimeStreamBuilder(trips);
    b.beginFeed();
    b.push(csv([
      { tripId: "t1", stopId: "s1", dep: "08:00:00", seq: 1 },
      { tripId: "t1", stopId: "s2", dep: "08:05:00", seq: 2 },
      { tripId: "t1", stopId: "s3", dep: "08:10:00", seq: 3 },
      { tripId: "t2", stopId: "s1", dep: "09:00:00", seq: 1 },
      { tripId: "t2", stopId: "s2", dep: "09:05:00", seq: 2 },
    ]));
    await b.endFeed();
    const result = await b.finish();
    expect(result.perStopRowCount.get("s1")).toBe(2);
    expect(result.perStopRowCount.get("s2")).toBe(2);
    expect(result.perStopRowCount.get("s3")).toBe(1);
    expect(result.perTripRowCount.get("t1")).toBe(3);
    expect(result.perTripRowCount.get("t2")).toBe(2);
  });

  it("orphan rows don't inflate known-trip counts", async () => {
    const trips = tripsIndex(["t1"]);
    const b = createStopTimeStreamBuilder(trips);
    b.beginFeed();
    b.push(csv([
      { tripId: "t1", stopId: "s1", dep: "08:00:00", seq: 1 },
      { tripId: "orphan", stopId: "s1", dep: "08:05:00", seq: 1 },
    ]));
    await b.endFeed();
    const result = await b.finish();
    expect(result.perTripRowCount.get("t1")).toBe(1);
  });
});
