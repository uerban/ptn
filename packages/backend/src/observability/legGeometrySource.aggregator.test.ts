import { describe, it, expect } from "vitest";
import {
  LegGeometryAggregator,
  TIME_TO_TIER_BUCKETS_MS,
} from "./legGeometrySource.aggregator.js";

describe("LegGeometryAggregator", () => {
  it("counts source events per source", () => {
    const agg = new LegGeometryAggregator();
    agg.ingest({
      event: "leg_geometry_source",
      data: { source: "shape", tripId: "t1" },
      ts: 0,
    });
    agg.ingest({
      event: "leg_geometry_source",
      data: { source: "shape", tripId: "t2" },
      ts: 1,
    });
    agg.ingest({
      event: "leg_geometry_source",
      data: { source: "endpoints", tripId: "t3" },
      ts: 2,
    });
    const snap = agg.read();
    expect(snap.shape.count).toBe(2);
    expect(snap.endpoints.count).toBe(1);
    expect(snap.intermediate.count).toBe(0);
  });

  it("populates a cumulative histogram for time-to-tier latency", () => {
    const agg = new LegGeometryAggregator();
    // Three observations: 100ms (bucket 0), 1500ms (bucket 4), 12000ms (bucket 9).
    agg.ingest({
      event: "leg_geometry_time_to_tier_ms",
      data: { source: "shape", tripId: "t1", ms: 100 },
      ts: 0,
    });
    agg.ingest({
      event: "leg_geometry_time_to_tier_ms",
      data: { source: "shape", tripId: "t2", ms: 1500 },
      ts: 1,
    });
    agg.ingest({
      event: "leg_geometry_time_to_tier_ms",
      data: { source: "shape", tripId: "t3", ms: 12_000 },
      ts: 2,
    });
    const snap = agg.read();
    const buckets = snap.shape.cumulative!;
    // Cumulative: every bucket ≥ the observation upper bound counts it.
    // 100ms ≤ 100, 250, 500, 1000, 1500, 2000, 3000, 5000, 10000, 15000, +Inf
    // 1500ms ≤ 1500, 2000, 3000, 5000, 10000, 15000, +Inf
    // 12000ms ≤ 15000, +Inf
    // Bucket index 0 (100ms) → 1, 1 (250) → 1, 2 (500) → 1, 3 (1000) → 1,
    // 4 (1500) → 2, 5 (2000) → 2, 6 (3000) → 2, 7 (5000) → 2, 8 (10000) → 2,
    // 9 (15000) → 3, 10 (+Inf) → 3.
    expect(buckets).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3]);
    expect(snap.shape.sumMs).toBe(13_600);
    expect(snap.shape.observations).toBe(3);
  });

  it("does not allocate a histogram for non-latency sources", () => {
    const agg = new LegGeometryAggregator();
    const snap = agg.read();
    expect(snap.endpoints.cumulative).toBeNull();
    expect(snap["osrm-foot"].cumulative).toBeNull();
    // The shape / intermediate sources DO carry latency.
    expect(snap.shape.cumulative).toEqual(
      new Array(TIME_TO_TIER_BUCKETS_MS.length).fill(0),
    );
    expect(snap.intermediate.cumulative).toEqual(
      new Array(TIME_TO_TIER_BUCKETS_MS.length).fill(0),
    );
  });

  it("rejects negative or non-finite latencies", () => {
    const agg = new LegGeometryAggregator();
    agg.ingest({
      event: "leg_geometry_time_to_tier_ms",
      data: { source: "shape", tripId: "t1", ms: -1 },
      ts: 0,
    });
    agg.ingest({
      event: "leg_geometry_time_to_tier_ms",
      data: { source: "shape", tripId: "t2", ms: Number.NaN },
      ts: 1,
    });
    const snap = agg.read();
    expect(snap.shape.observations).toBe(0);
    expect(snap.shape.sumMs).toBe(0);
  });

  it("read() is a defensive copy — callers cannot mutate state", () => {
    const agg = new LegGeometryAggregator();
    agg.ingest({
      event: "leg_geometry_source",
      data: { source: "shape", tripId: "t1" },
      ts: 0,
    });
    const before = agg.read();
    before.shape.count = 999;
    const after = agg.read();
    expect(after.shape.count).toBe(1);
  });

  it("reset() clears all aggregates", () => {
    const agg = new LegGeometryAggregator();
    agg.ingest({
      event: "leg_geometry_source",
      data: { source: "shape", tripId: "t1" },
      ts: 0,
    });
    agg.reset();
    const snap = agg.read();
    expect(snap.shape.count).toBe(0);
  });
});
