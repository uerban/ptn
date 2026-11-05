import { describe, it, expect } from "vitest";
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

describe("parseTripUpdatesBuffer", () => {
  it("clamps extreme delaySeconds values before storing them", async () => {
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
          stopTimeUpdate: [{ arrival: { delay: -5400 } }],
        },
      },
      {
        id: "normal",
        tripUpdate: {
          trip: { tripId: "trip-normal" },
          stopTimeUpdate: [{ departure: { delay: 120 } }],
        },
      },
    ]);

    const updates = await parseTripUpdatesBuffer(data);

    expect(updates.get("trip-positive")).toEqual({ delaySeconds: 1800, cancelled: false });
    expect(updates.get("trip-negative")).toEqual({ delaySeconds: -1800, cancelled: false });
    expect(updates.get("trip-normal")).toEqual({ delaySeconds: 120, cancelled: false });
  });

  it("keeps bare and date-scoped keys in sync", async () => {
    const data = await encodeFeed([
      {
        id: "dated",
        tripUpdate: {
          trip: { tripId: "trip-1", startDate: "20250602" },
          stopTimeUpdate: [{ departure: { delay: 60 } }],
        },
      },
    ]);

    const updates = await parseTripUpdatesBuffer(data);

    expect(updates.get("trip-1")).toEqual({ delaySeconds: 60, cancelled: false });
    expect(updates.get("trip-1|20250602")).toEqual({ delaySeconds: 60, cancelled: false });
  });
});
