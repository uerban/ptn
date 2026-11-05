import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { loadGtfs } from "./loader.js";
import type { GtfsFrequency, GtfsTransfer } from "./parser.js";

describe("loadGtfs transfers.txt ingest", () => {
  const tmpFile = join(tmpdir(), `ptn-loader-transfers-${process.pid}.zip`);

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    delete process.env.PT_ALLOW_FILE_URLS;
  });

  const BASE_FILES: Record<string, Uint8Array> = {
    "stops.txt": strToU8("stop_id,stop_name,stop_lat,stop_lon\ns1,Stop 1,0,0\ns2,Stop 2,0,0\n"),
    "routes.txt": strToU8("route_id,route_short_name,route_long_name,route_type\nr1,R,Route,3\n"),
    "trips.txt": strToU8("route_id,service_id,trip_id\nr1,svc,t1\n"),
    "calendar.txt": strToU8("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,0,0,20260101,20301231\n"),
    "stop_times.txt": strToU8("trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,s1,1\nt1,08:10:00,08:10:00,s2,2\n"),
  };

  function writeZip(extra: Record<string, Uint8Array> = {}): void {
    writeFileSync(tmpFile, Buffer.from(zipSync({ ...BASE_FILES, ...extra })));
  }

  it("populates result.transfers from a feed WITH transfers.txt", async () => {
    writeZip({
      "transfers.txt": strToU8(
        "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n" +
          "s1,s2,2,180\n" +
          "s2,s1,0,\n",
      ),
    });
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.transfers).toEqual<GtfsTransfer[]>([
      {
        fromStopId: "s1",
        toStopId: "s2",
        transferType: 2,
        minTransferSecs: 180,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
      },
      {
        fromStopId: "s2",
        toStopId: "s1",
        transferType: 0,
        minTransferSecs: undefined,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
      },
    ]);
  });

  it("yields [] for a feed WITHOUT transfers.txt", async () => {
    writeZip();
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.transfers).toEqual([]);
  });

  it("populates result.frequencies from a network feed WITH frequencies.txt", async () => {
    writeZip({
      "frequencies.txt": strToU8(
        "trip_id,start_time,end_time,headway_secs,exact_times\n" +
          "t1,08:00:00,25:00:00,600,0\n" +
          "t1,26:00:00,27:00:00,900,1\n",
      ),
    });
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.frequencies).toEqual<GtfsFrequency[]>([
      { tripId: "t1", startSecs: 28800, endSecs: 90000, headwaySecs: 600, exactTimes: 0 },
      { tripId: "t1", startSecs: 93600, endSecs: 97200, headwaySecs: 900, exactTimes: 1 },
    ]);

  });

  it("leaves result.frequencies undefined for a feed WITHOUT frequencies.txt", async () => {
    writeZip();
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.frequencies).toBeUndefined();
  });
});
