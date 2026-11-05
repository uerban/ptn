import { describe, it, expect, vi } from "vitest";
import { parseTripUpdatesBuffer } from "../../src/gtfs/realtime.js";

async function encodeFeed(entity: unknown[]): Promise<Uint8Array> {
  const GtfsRealtimeBindings = await import("gtfs-realtime-bindings");
  const { transit_realtime } = GtfsRealtimeBindings.default ?? GtfsRealtimeBindings;
  return transit_realtime.FeedMessage.encode({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: 0,
    },
    entity,
  }).finish();
}

describe("GTFS-RT delaySeconds clamping", () => {
  it("caps extreme positive and negative delays", async () => {
    const data = await encodeFeed([
      {
        id: "positive",
        tripUpdate: {
          trip: { tripId: "trip-positive" },
          stopTimeUpdate: [{ departure: { delay: 7200 } }],
        },
      },
      {
        id: "negative",
        tripUpdate: {
          trip: { tripId: "trip-negative" },
          stopTimeUpdate: [{ arrival: { delay: -7200 } }],
        },
      },
    ]);

    const updates = await parseTripUpdatesBuffer(data);

    expect(updates.get("trip-positive")?.delaySeconds).toBe(1800);
    expect(updates.get("trip-negative")?.delaySeconds).toBe(-1800);
  });

  it("passes values at the boundary through unchanged", async () => {
    const data = await encodeFeed([
      {
        id: "at-pos-boundary",
        tripUpdate: {
          trip: { tripId: "trip-at-max" },
          stopTimeUpdate: [{ departure: { delay: 1800 } }],
        },
      },
      {
        id: "at-neg-boundary",
        tripUpdate: {
          trip: { tripId: "trip-at-min" },
          stopTimeUpdate: [{ departure: { delay: -1800 } }],
        },
      },
    ]);

    const updates = await parseTripUpdatesBuffer(data);

    expect(updates.get("trip-at-max")?.delaySeconds).toBe(1800);
    expect(updates.get("trip-at-min")?.delaySeconds).toBe(-1800);
  });

  it("clamps values one second past the boundary", async () => {
    const data = await encodeFeed([
      {
        id: "just-over",
        tripUpdate: {
          trip: { tripId: "trip-1801" },
          stopTimeUpdate: [{ departure: { delay: 1801 } }],
        },
      },
      {
        id: "just-under",
        tripUpdate: {
          trip: { tripId: "trip-minus-1801" },
          stopTimeUpdate: [{ departure: { delay: -1801 } }],
        },
      },
    ]);

    const updates = await parseTripUpdatesBuffer(data);

    expect(updates.get("trip-1801")?.delaySeconds).toBe(1800);
    expect(updates.get("trip-minus-1801")?.delaySeconds).toBe(-1800);
  });

  it("falls back to zero when the feed omits stop-time updates", async () => {
    const data = await encodeFeed([
      {
        id: "missing-stop-times",
        tripUpdate: {
          trip: { tripId: "trip-zero" },
        },
      },
    ]);

    const updates = await parseTripUpdatesBuffer(data);

    expect(updates.get("trip-zero")).toEqual({ delaySeconds: 0, cancelled: false });
  });

  it("emits a debug log when a delay is clamped", async () => {
    const data = await encodeFeed([
      {
        id: "over",
        tripUpdate: {
          trip: { tripId: "trip-over" },
          stopTimeUpdate: [{ departure: { delay: 7200 } }],
        },
      },
    ]);
    const debug = vi.fn();
    const logger = { debug } as unknown as Parameters<typeof parseTripUpdatesBuffer>[1];

    await parseTripUpdatesBuffer(data, logger);

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ tripId: "trip-over", rawDelay: 7200, clamped: 1800 }),
      expect.stringContaining("clamped"),
    );
  });
});
