import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { loadGtfs } from "./loader.js";

describe("loadGtfs cityTzIana from agency.txt", () => {
  const tmpFile = join(tmpdir(), `ptn-loader-cityTz-${process.pid}.zip`);

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

  it("sets cityTzIana from a feed WITH agency.txt (agency_timezone)", async () => {
    writeZip({
      "agency.txt": strToU8(
        "agency_id,agency_name,agency_url,agency_timezone\n" +
          "a1,Vilniaus,https://vilnius.example,Europe/Vilnius\n",
      ),
    });
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.cityTzIana).toBe("Europe/Vilnius");
  });

  it("leaves cityTzIana undefined for a feed WITHOUT agency.txt", async () => {
    writeZip();
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.cityTzIana).toBeUndefined();
  });

  it("leaves cityTzIana undefined when agency.txt has a blank agency_timezone", async () => {
    writeZip({
      "agency.txt": strToU8(
        "agency_id,agency_name,agency_url,agency_timezone\n" +
          "a1,No TZ,https://notz.example,\n",
      ),
    });
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    expect(result!.cityTzIana).toBeUndefined();
  });
});
