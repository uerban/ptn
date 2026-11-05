import { describe, it, expect } from "vitest";
import { parseTransfers, type GtfsTransfer } from "./parser.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseTransfers", () => {
  it("parses one row per transfer_type, blank transfer_type -> 0, optional ids/time handled", async () => {
    const csv = [
      "from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_route_id,to_route_id,from_trip_id,to_trip_id",
      // transfer_type 0..5, each with all optional columns populated
      "s0a,s0b,0,120,r0a,r0b,t0a,t0b",
      "s1a,s1b,1,,r1a,r1b,t1a,t1b",
      "s2a,s2b,2,300,r2a,r2b,t2a,t2b",
      "s3a,s3b,3,,r3a,r3b,t3a,t3b",
      "s4a,s4b,4,60,r4a,r4b,t4a,t4b",
      "s5a,s5b,5,,r5a,r5b,t5a,t5b",
      // blank transfer_type -> 0
      "sba,sbb,,,,,,",
      // absent optional id columns (empty) + no min_transfer_time
      "soa,sob,1,,,,,",
    ].join("\n");

    const rows = await parseTransfers(enc(csv));

    expect(rows).toEqual<GtfsTransfer[]>([
      {
        fromStopId: "s0a",
        toStopId: "s0b",
        transferType: 0,
        minTransferSecs: 120,
        fromRouteId: "r0a",
        toRouteId: "r0b",
        fromTripId: "t0a",
        toTripId: "t0b",
      },
      {
        fromStopId: "s1a",
        toStopId: "s1b",
        transferType: 1,
        minTransferSecs: undefined,
        fromRouteId: "r1a",
        toRouteId: "r1b",
        fromTripId: "t1a",
        toTripId: "t1b",
      },
      {
        fromStopId: "s2a",
        toStopId: "s2b",
        transferType: 2,
        minTransferSecs: 300,
        fromRouteId: "r2a",
        toRouteId: "r2b",
        fromTripId: "t2a",
        toTripId: "t2b",
      },
      {
        fromStopId: "s3a",
        toStopId: "s3b",
        transferType: 3,
        minTransferSecs: undefined,
        fromRouteId: "r3a",
        toRouteId: "r3b",
        fromTripId: "t3a",
        toTripId: "t3b",
      },
      {
        fromStopId: "s4a",
        toStopId: "s4b",
        transferType: 4,
        minTransferSecs: 60,
        fromRouteId: "r4a",
        toRouteId: "r4b",
        fromTripId: "t4a",
        toTripId: "t4b",
      },
      {
        fromStopId: "s5a",
        toStopId: "s5b",
        transferType: 5,
        minTransferSecs: undefined,
        fromRouteId: "r5a",
        toRouteId: "r5b",
        fromTripId: "t5a",
        toTripId: "t5b",
      },
      {
        fromStopId: "sba",
        toStopId: "sbb",
        transferType: 0,
        minTransferSecs: undefined,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
      },
      {
        fromStopId: "soa",
        toStopId: "sob",
        transferType: 1,
        minTransferSecs: undefined,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
      },
    ]);
  });

  it("returns [] for header-only input", async () => {
    const rows = await parseTransfers(
      enc("from_stop_id,to_stop_id,transfer_type,min_transfer_time\n"),
    );
    expect(rows).toEqual([]);
  });

  it("coerces malformed transfer_type/min_transfer_time to safe values (no NaN leak)", async () => {
    // Regression: a non-numeric transfer_type must NOT become NaN (would poison
    // the S1 switch); a non-numeric or negative min_transfer_time must become
    // undefined (absent), matching the producer parser.
    const csv = [
      "from_stop_id,to_stop_id,transfer_type,min_transfer_time",
      "a,b,x,abc", // both malformed
      "c,d,2,-5", // negative min_transfer_time
      "e,f,300,99", // transfer_type > 255 (u8 parse fails) -> 0
    ].join("\n");

    const rows = await parseTransfers(enc(csv));

    expect(rows[0]!.transferType).toBe(0);
    expect(rows[0]!.minTransferSecs).toBeUndefined();
    expect(rows[1]!.transferType).toBe(2);
    expect(rows[1]!.minTransferSecs).toBeUndefined();
    expect(rows[2]!.transferType).toBe(0);
    // none should be NaN
    for (const r of rows) {
      expect(Number.isNaN(r.transferType)).toBe(false);
      expect(r.minTransferSecs === undefined || Number.isFinite(r.minTransferSecs)).toBe(true);
    }
  });
});
