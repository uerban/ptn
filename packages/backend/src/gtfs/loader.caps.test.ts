import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { loadGtfs } from "./loader.js";

describe("loader file:// gate", () => {
  const tmpFile = join(tmpdir(), `ptn-loader-cap-${process.pid}.zip`);

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    delete process.env.PT_ALLOW_FILE_URLS;
  });

  function writeValidGtfsZip(): void {
    writeFileSync(tmpFile, Buffer.from(zipSync({
      "stops.txt": strToU8("stop_id,stop_name,stop_lat,stop_lon\ns1,Stop 1,0,0\n"),
      "routes.txt": strToU8("route_id,route_short_name,route_long_name,route_type\nr1,R,Route,3\n"),
      "trips.txt": strToU8("route_id,service_id,trip_id\nr1,svc,t1\n"),
      "calendar.txt": strToU8("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,0,0,20260101,20301231\n"),
      "stop_times.txt": strToU8("trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,s1,1\n"),
    })));
  }

  it("rejects file:// URLs when PT_ALLOW_FILE_URLS not set", async () => {
    writeValidGtfsZip();
    delete process.env.PT_ALLOW_FILE_URLS;
    await expect(loadGtfs([`file://${tmpFile}`])).rejects.toThrow(/file:\/\/|scheme|disabled/i);
  });

  it("accepts file:// URLs when PT_ALLOW_FILE_URLS=1", async () => {
    writeValidGtfsZip();
    process.env.PT_ALLOW_FILE_URLS = "1";
    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
  });

  it("rejects file:// URLs when PT_ALLOW_FILE_URLS=0 explicitly", async () => {
    writeValidGtfsZip();
    process.env.PT_ALLOW_FILE_URLS = "0";
    await expect(loadGtfs([`file://${tmpFile}`])).rejects.toThrow(/file:\/\/|scheme|disabled/i);
  });
});
