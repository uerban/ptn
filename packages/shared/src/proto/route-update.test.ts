import { describe, it, expect } from "vitest";
import { encodeRouteUpdate, decodeRouteUpdate, type RtRouteUpdate } from "./route-update.js";

describe("RtTripUpdate.startDate (TS interface only, not protobuf)", () => {
  it("encode/decode of a RouteUpdate IGNORES startDate (it is not a protobuf field)", () => {
    const update: RtRouteUpdate = {
      routeId: "R1",
      generatedAt: 1,
      trips: [{ tripId: "T1", delaySeconds: 60, cancelled: false, startDate: "20260611" }],
    };
    const decoded = decodeRouteUpdate(encodeRouteUpdate(update));
    expect(decoded.trips[0]!.tripId).toBe("T1");
    expect(decoded.trips[0]!.delaySeconds).toBe(60);
    expect((decoded.trips[0] as { startDate?: string }).startDate).toBeUndefined();
  });
});

describe("RtTripUpdate.deleted (protobuf field 4)", () => {
  // pt-serve's bytes for { routeId: "r", trips: [{ tripId: "t", delaySeconds: 0,
  // cancelled: false, deleted: true }], generatedAt: 0 } — field 4 is emitted
  // only when true (crates/pt-serve/src/rt/encode.rs).
  const DELETED_TRIP = new Uint8Array([
    0x0a, 0x01, 0x72, // routeId = "r"
    0x12, 0x09, // trips, 9-byte sub-message
    0x0a, 0x01, 0x74, //   tripId = "t"
    0x10, 0x00, //   delaySeconds = 0
    0x18, 0x00, //   cancelled = false
    0x20, 0x01, //   deleted = true
    0x18, 0x00, // generatedAt = 0
  ]);
  const RUNNING_TRIP = new Uint8Array([
    0x0a, 0x01, 0x72, 0x12, 0x07, 0x0a, 0x01, 0x74, 0x10, 0x00, 0x18, 0x00, 0x18, 0x00,
  ]);

  it("reads a deleted trip as deleted", () => {
    expect(decodeRouteUpdate(DELETED_TRIP).trips[0]).toMatchObject({ tripId: "t", deleted: true });
  });

  it("leaves it absent on a trip without the field — every body before it", () => {
    expect(decodeRouteUpdate(RUNNING_TRIP).trips[0]!.deleted).toBeUndefined();
  });
});
