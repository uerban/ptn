import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { loadGtfs } from "../../src/gtfs/loader.js";

describe("loadGtfs builds Identity", () => {
  const tmpFile = join(tmpdir(), `ptn-loader-identity-${process.pid}.zip`);

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    delete process.env.PT_ALLOW_FILE_URLS;
  });

  it("populates identity.stops/routes/services/trips/headsigns/bitmasks", async () => {
    writeFileSync(tmpFile, Buffer.from(zipSync({
      "stops.txt": strToU8("stop_id,stop_name,stop_lat,stop_lon\ns1,Stop 1,54.68,25.28\ns2,Stop 2,54.69,25.29\n"),
      "routes.txt": strToU8("route_id,route_short_name,route_long_name,route_type\nr1,R1,Route One,3\n"),
      "trips.txt": strToU8("route_id,service_id,trip_id,trip_headsign\nr1,svc,t1,Downtown\nr1,svc,t2,Downtown\nr1,svc,t3,Airport\n"),
      "calendar.txt": strToU8("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,0,0,20260101,20301231\n"),
      "stop_times.txt": strToU8("trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,s1,1\nt1,08:05:00,08:05:00,s2,2\nt2,09:00:00,09:00:00,s1,1\nt3,10:00:00,10:00:00,s2,1\n"),
    })));
    process.env.PT_ALLOW_FILE_URLS = "1";

    const result = await loadGtfs([`file://${tmpFile}`]);
    expect(result).not.toBeNull();
    const id = result!.indexes.identity;
    expect(id).toBeDefined();
    expect(id.stops.size).toBe(2);
    expect(id.routes.size).toBe(1);
    expect(id.trips.size).toBe(3);
    expect(id.headsigns.size).toBe(2);
    expect(id.services.size).toBe(1);
    expect(id.bitmasks.has("svc")).toBe(true);
    expect(id.buildDateIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
