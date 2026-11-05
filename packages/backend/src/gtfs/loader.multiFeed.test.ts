import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { loadGtfs } from "./loader.js";

/**
 * Multi-feed `loadGtfs` coverage. Every other loader test passes a SINGLE
 * `file://` URL, so the merge loop + the per-feed `zipBuffer` release added for
 * the cold-load memory reduction (each feed's bytes are nulled after its
 * stop_times stream, with feedFiles sha256 computed up front) had no test that
 * iterated more than one feed. This exercises the two-feed path end to end.
 */
describe("loadGtfs — multi-feed merge + per-feed zipBuffer release", () => {
  const tmpA = join(tmpdir(), `ptn-loader-mf-a-${process.pid}.zip`);
  const tmpB = join(tmpdir(), `ptn-loader-mf-b-${process.pid}.zip`);

  afterEach(() => {
    for (const f of [tmpA, tmpB]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    delete process.env.PT_ALLOW_FILE_URLS;
  });

  function feedFiles(prefix: string): Record<string, Uint8Array> {
    return {
      "stops.txt": strToU8(
        `stop_id,stop_name,stop_lat,stop_lon\n${prefix}s1,${prefix} Stop 1,0,0\n${prefix}s2,${prefix} Stop 2,0,0\n`,
      ),
      "routes.txt": strToU8(
        `route_id,route_short_name,route_long_name,route_type\n${prefix}r1,R,Route,3\n`,
      ),
      "trips.txt": strToU8(`route_id,service_id,trip_id\n${prefix}r1,svc,${prefix}t1\n`),
      "calendar.txt": strToU8(
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,0,0,20260101,20301231\n",
      ),
      "stop_times.txt": strToU8(
        `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${prefix}t1,08:00:00,08:00:00,${prefix}s1,1\n${prefix}t1,08:10:00,08:10:00,${prefix}s2,2\n`,
      ),
    };
  }

  it("merges two feeds and reports correct per-feed blobSha256 for both", async () => {
    const bytesA = Buffer.from(zipSync(feedFiles("a")));
    const bytesB = Buffer.from(zipSync(feedFiles("b")));
    writeFileSync(tmpA, bytesA);
    writeFileSync(tmpB, bytesB);
    process.env.PT_ALLOW_FILE_URLS = "1";

    const urlA = `file://${tmpA}`;
    const urlB = `file://${tmpB}`;
    const result = await loadGtfs([urlA, urlB]);
    expect(result).not.toBeNull();

    // Both feeds' disjoint stops/routes/trips are present in the merged index.
    const id = result!.indexes.identity;
    expect(id.stops.size).toBe(4); // as1,as2,bs1,bs2
    expect(id.routes.size).toBe(2); // ar1,br1
    expect(id.trips.size).toBe(2); // at1,bt1

    // feedFiles sha256 is computed up front (before each zipBuffer is nulled),
    // so both entries must carry the correct hash of their raw zip bytes.
    const byPath = new Map(result!.feedFiles.map((f) => [f.path, f.blobSha256]));
    expect(byPath.get(urlA)).toBe(createHash("sha256").update(bytesA).digest("hex"));
    expect(byPath.get(urlB)).toBe(createHash("sha256").update(bytesB).digest("hex"));
  });
});
