/**
 * Tests for the PTB reader.
 *
 * `tiny.ptb` and `canary.ptb` are the Rust producer's own output for the
 * committed GTFS feeds under `crates/pt-producer/tests/fixtures/`
 * (`tiny-gtfs.zip`, `canary-gtfs.zip`; see that directory's README for the
 * regeneration command). The other fixtures come from `pt-core-emit`. Every
 * fixture here is a PTB v1 bundle (v2 lives in loaderV2.test.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FREQUENCIES_REGION_ID,
  SERVICE_WINDOW_DAYS,
  bytesPerService,
  fnv1a32,
  loadPtb,
  lookupStopIndexRegion,
  readWindowProvenance,
} from "./loader.js";

const fixtureBuf = (): Buffer =>
  readFileSync(new URL("./__fixtures__/tiny.ptb", import.meta.url));
const fixtureBufCanary = (): Buffer =>
  readFileSync(new URL("./__fixtures__/canary.ptb", import.meta.url));

const fixtureBufServicePool = (): Buffer =>
  readFileSync(new URL("./__fixtures__/tiny-service-pool.ptb", import.meta.url));
const fixtureBufFrequencies = (): Buffer =>
  readFileSync(new URL("./__fixtures__/frequencies-parity.ptb", import.meta.url));
const fixtureBufWindow400 = (): Buffer =>
  readFileSync(new URL("./__fixtures__/window400.ptb", import.meta.url));
const frontendFixtureBuf = (name: string): Buffer =>
  readFileSync(new URL(`../../../frontend/tests/services/__fixtures__/${name}`, import.meta.url));

/** Offset of the tagged region-table entry for `regionId` (24 B entries @32). */
function taggedEntryOffset(buf: Buffer, regionId: number): number {
  for (let e = 32; e + 24 <= 4096; e += 24) {
    const id = buf.readUInt16LE(e);
    if (id === 0) break;
    if (id === regionId) return e;
  }
  throw new Error(`region 0x${regionId.toString(16)} not in the tagged table`);
}

/** True when `serviceIdx` is active on day `day` of the bundle's window. */
function serviceActiveOnDay(
  b: ReturnType<typeof loadPtb>,
  serviceIdx: number,
  day: number,
): boolean {
  const stride = bytesPerService(b.windowDays);
  const byte = b.serviceBitmasks[serviceIdx * stride + (day >> 3)]!;
  return ((byte >> (day & 7)) & 1) === 1;
}

describe("loadPtb — header", () => {
  it("parses magic, version, and feedStartDate", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.magic).toBe("PTB");
    expect(r.version).toBe(1);
    expect(r.feedStartDate).toBe(20260501);
  });
});

describe("loadPtb — stops", () => {
  it("decodes stops in post-finalize sorted order with lat/lon round-trip", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.stops.map((s) => s.stopId)).toEqual(["S1", "S2", "S3"]);
    expect(r.stops.map((s) => s.stopName)).toEqual(["Stop One", "Stop Two", "Stop Three"]);
    expect(r.stops[0].stopLat).toBeCloseTo(54.69, 2);
    expect(r.stops[0].stopLon).toBeCloseTo(25.28, 2);
  });

  it("decodes wheelchair_boarding and parent_station", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.stops.map((s) => s.wheelchairBoarding)).toEqual([0, 1, 0]);
    // stops.txt: S2 and S3 have parent_station S1.
    expect(r.stopParents).toEqual([
      { childIdx: 1, parentIdx: 0 },
      { childIdx: 2, parentIdx: 0 },
    ]);
  });
});

describe("loadPtb — routes", () => {
  it("decodes routes with agency, short, long, type round-trip", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.routes.map((rt) => rt.routeId)).toEqual(["R1", "R2"]);
    expect(r.routes.map((rt) => rt.agencyId)).toEqual(["P1", "P1"]);
    expect(r.routes.map((rt) => rt.routeShortName)).toEqual(["1", "2"]);
    expect(r.routes.map((rt) => rt.routeLongName)).toEqual(["Route One", "Route Two"]);
    expect(r.routes.every((rt) => rt.routeType === 3)).toBe(true);
  });

  it("decodes route colors", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.routes[0]!.routeColor).toBe("FF0000");
    expect(r.routes[0]!.routeTextColor).toBe("FFFFFF");
    expect(r.routes[1]!.routeColor).toBe("00FF00");
    expect(r.routes[1]!.routeTextColor).toBe("000000");
  });

  it("decodes empty routeColor and routeTextColor as empty strings (not undefined)", () => {
    // Consumers depend on the empty-string contract for absent colours.
    const r = loadPtb(frontendFixtureBuf("branch-pattern.ptb"));
    expect(r.routes[0]!.routeColor).toBe("");
    expect(r.routes[0]!.routeTextColor).toBe("");
  });
});

describe("loadPtb — trips", () => {
  it("decodes trips with route_idx + service_idx", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.trips.map((t) => t.tripId)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(r.trips.map((t) => t.routeIdx)).toEqual([0, 0, 1, 1]);
    // services sort SA (0), WD (1); T4 runs on SA.
    expect(r.trips.map((t) => t.serviceIdx)).toEqual([1, 1, 1, 0]);
  });

  it("decodes direction_id, shape_id, wheelchair_accessible, and empty headsigns", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.trips.map((t) => t.directionId)).toEqual([0, 1, 0, 1]);
    expect(r.trips.map((t) => t.shapeId)).toEqual(["shp_A", "shp_B", "shp_C", "shp_D"]);
    expect(r.trips.map((t) => t.wheelchairAccessible)).toEqual([2, 0, 0, 0]);
    expect(r.trips.every((t) => t.headsign === "")).toBe(true);
  });

  it("decodes an absent shape_id as an empty string", () => {
    const r = loadPtb(fixtureBufCanary());
    expect(r.trips[0]!.shapeId).toBe("");
  });

  it("decodes bikes_allowed", () => {
    const r = loadPtb(frontendFixtureBuf("bikes-skip.ptb"));
    expect(r.trips[0]!.bikesAllowed).toBe(2);
  });
});

describe("loadPtb — stop_times", () => {
  it("materializes rows from the band; stopSeq is the pattern position", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.stopTimes).toHaveLength(12);
    // Row 0: T1 at S1, 07:00:00.
    expect(r.stopTimes[0]).toEqual({ depSecs: 25200, arrDiff: 0, stopIdx: 0, stopSeq: 0 });
    // Row 6: T3 at S3 (reverse-direction trip), 09:00:00.
    expect(r.stopTimes[6]).toEqual({ depSecs: 32400, arrDiff: 0, stopIdx: 2, stopSeq: 0 });
    // Row 10: T4 at S2, 25:30:00 (91800) — service-day rollover preserved.
    expect(r.stopTimes[10].depSecs).toBe(91800);
  });
});

describe("loadPtb — tripStarts", () => {
  it("decodes a Uint32Array of length trips.length+1, monotonic, last == stopTimes.length", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.tripStarts).toBeInstanceOf(Uint32Array);
    expect(r.tripStarts.length).toBe(r.trips.length + 1);
    expect(r.tripStarts[0]).toBe(0);
    for (let i = 1; i < r.tripStarts.length; i++) {
      expect(r.tripStarts[i]!).toBeGreaterThanOrEqual(r.tripStarts[i - 1]!);
    }
    expect(r.tripStarts[r.tripStarts.length - 1]).toBe(r.stopTimes.length);
  });

  it("slices each trip's contiguous stop_times row range exactly", () => {
    const r = loadPtb(fixtureBuf());
    // 4 trips × 3 stops each = 12 rows, evenly split.
    expect(Array.from(r.tripStarts)).toEqual([0, 3, 6, 9, 12]);
  });
});

describe("loadPtb — CSR", () => {
  it("synthesizes route_trips from per-trip routeIdx; last == values.length", () => {
    const r = loadPtb(fixtureBuf());
    expect(Array.from(r.routeTripsOffsets)).toEqual([0, 2, 4]);
    expect(Array.from(r.routeTripsValues)).toEqual([0, 1, 2, 3]);
    expect(r.routeTripsOffsets[r.routeTripsOffsets.length - 1]).toBe(
      r.routeTripsValues.length,
    );
  });

  it("leaves stop_routes empty on a carry-less bundle (0x45 PatternsAtStop drives it)", () => {
    const r = loadPtb(fixtureBuf());
    expect(Array.from(r.stopRoutesOffsets)).toEqual([0, 0, 0, 0]);
    expect(Array.from(r.stopRoutesValues)).toEqual([]);
  });
});

describe("loadPtb — service bitmasks", () => {
  it("reads numServices authoritatively from header bytes [24..28]", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.numServices).toBe(2);
  });

  it("materializes one bitmask per service at the window stride", () => {
    const r = loadPtb(fixtureBuf());
    expect(r.serviceBitmasks.byteLength).toBe(r.numServices * bytesPerService(r.windowDays));
  });

  it("follows calendar.txt and calendar_dates.txt", () => {
    const r = loadPtb(fixtureBuf());
    // SA (0) runs Saturdays, WD (1) weekdays; day 0 is Friday 20260501.
    expect(serviceActiveOnDay(r, 0, 0)).toBe(false);
    expect(serviceActiveOnDay(r, 1, 0)).toBe(true);
    expect(serviceActiveOnDay(r, 0, 1)).toBe(true);
    expect(serviceActiveOnDay(r, 1, 1)).toBe(false);
    // calendar_dates.txt removes WD on 20260520 (day 19); 20260519 still runs.
    expect(serviceActiveOnDay(r, 1, 18)).toBe(true);
    expect(serviceActiveOnDay(r, 1, 19)).toBe(false);
  });
});

describe("loadPtb — byte views", () => {
  it("parses a browser Uint8Array view with a non-zero byteOffset", () => {
    const source = fixtureBuf();
    const slab = new Uint8Array(source.byteLength + 13);
    slab.set(source, 7);
    const view = slab.subarray(7, 7 + source.byteLength);

    const r = loadPtb(view);
    expect(r.stops.length).toBe(3);
    expect(r.trips.length).toBe(4);
  });
});

describe("loadPtb — negative path", () => {
  it("throws on tampered magic", () => {
    const buf = Buffer.from(fixtureBuf());
    buf[0] = 0x58;
    expect(() => loadPtb(buf)).toThrow(/bad magic/);
  });

  it("rejects a genuine v3 bundle (ASCII magic PTNB + version 3)", () => {
    // A real v3 bundle has ASCII magic 0x50 0x54 0x4E 0x42 ("PTNB") plus
    // version u16=3 at bytes [4..6]. The loader must reject it at the MAGIC
    // check (before it even sees the version byte), throwing /bad magic/.
    const v3buf = Buffer.alloc(4096);
    v3buf.write("PTNB", 0, "ascii"); // bytes 0..4: 0x50 0x54 0x4E 0x42
    v3buf.writeUInt16LE(3, 4); // version u16 = 3
    expect(() => loadPtb(v3buf)).toThrow(/bad magic/);
  });

  it("rejects every version but 1 and 2, including the pre-v1 4..=9 layouts", () => {
    const buf = Buffer.from(fixtureBuf());
    for (const v of [0, 3, 4, 5, 6, 7, 8, 9, 10, 99]) {
      buf.writeUInt16LE(v, 4);
      expect(() => loadPtb(buf), `version ${v}`).toThrow(/unsupported version/);
    }
  });

  it("does not let a v1 bundle relabelled as v2 skip the mandatory v2 regions", () => {
    const buf = Buffer.from(fixtureBuf());
    buf.writeUInt16LE(2, 4);
    expect(() => loadPtb(buf)).toThrow(/missing required region serviceDayOrigins/);
  });

  it("throws on truncated buffer", () => {
    const truncated = Buffer.from(fixtureBuf()).subarray(0, 4095);
    expect(() => loadPtb(truncated)).toThrow(/too small for header/);
  });

  it("throws when a region offset+length exceeds buffer", () => {
    const buf = Buffer.from(fixtureBuf());
    // Point the 0x40 StopsSoA entry's length past the end of the buffer.
    const entry = taggedEntryOffset(buf, 0x40);
    buf.writeBigUInt64LE(BigInt(buf.length + 1024), entry + 16);
    expect(() => loadPtb(buf)).toThrow(/region 0x40 region out of bounds/);
  });

  it("throws when numStops header count exceeds the stops region capacity", () => {
    const buf = Buffer.from(fixtureBuf());
    buf.writeUInt32LE(205, 8);
    expect(() => loadPtb(buf)).toThrow(/exceeds region capacity/);
  });

  it("throws on a string index past the pool", () => {
    const buf = Buffer.from(fixtureBuf());
    // The first StopsSoA column is the stop-id pool index.
    const soaOff = Number(buf.readBigUInt64LE(taggedEntryOffset(buf, 0x40) + 8));
    buf.writeUInt32LE(0xffffff, soaOff);
    expect(() => loadPtb(buf)).toThrow(/string index out of range/);
  });

  it("throws on stringPool length mismatch", () => {
    const buf = Buffer.from(fixtureBuf());
    const poolOff = loadPtb(buf).regions.stringPool.offset;
    buf.writeUInt32LE(buf.readUInt32LE(poolOff) + 1, poolOff);
    expect(() => loadPtb(buf)).toThrow(/stringPool length mismatch/);
  });

  it("throws on stringPool count overflow", () => {
    const buf = Buffer.from(fixtureBuf());
    const poolOff = loadPtb(buf).regions.stringPool.offset;
    buf.writeUInt32LE(buf.readUInt32LE(poolOff) + 100, poolOff);
    expect(() => loadPtb(buf)).toThrow(/overflows region length/);
  });
});

describe("loadPtb — non-ASCII canary", () => {
  it("decodes multi-byte UTF-8 ids and names from the string pool", () => {
    const b = loadPtb(fixtureBufCanary());
    expect(b.stops.map((s) => s.stopId)).toEqual(["Aa", "Žz"]);
    expect(b.stops.map((s) => s.stopName)).toEqual(["Centras", "Žalgiris"]);
    expect(b.routes[0]!.routeId).toBe("Š1");
    expect(b.routes[0]!.routeShortName).toBe("Š");
    expect(b.routes[0]!.routeLongName).toBe("Šiaurė");
    expect(b.trips[0]!.tripId).toBe("tŠ-1");
    // The headsign and the route long name share one pooled string.
    expect(b.trips[0]!.headsign).toBe(b.routes[0]!.routeLongName);
  });

  it("decodes a negative dwell", () => {
    const b = loadPtb(fixtureBufCanary());
    expect(b.stopTimes[0]).toEqual({ depSecs: 120, arrDiff: -3, stopIdx: 0, stopSeq: 0 });
  });
});

// GTFS transfers.txt reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
describe("loadPtb — Transfers region", () => {
  it("decodes an unscoped type-3 row and a type-2 row with minTransferSecs", () => {
    const blocked = loadPtb(frontendFixtureBuf("transfer-block.ptb"));
    expect(blocked.transfers).toEqual([{ fromStopIdx: 1, toStopIdx: 1, transferType: 3 }]);
    expect(blocked.transfers[0]!.minTransferSecs).toBeUndefined();
    const minTime = loadPtb(frontendFixtureBuf("transfer-mintime-feasible.ptb"));
    expect(minTime.transfers).toEqual([
      { fromStopIdx: 1, toStopIdx: 1, minTransferSecs: 300, transferType: 2 },
    ]);
  });

  it("carries route- and trip-scoped indices", () => {
    const b = loadPtb(frontendFixtureBuf("transfer-scoped-trip-beats-route.ptb"));
    expect(b.transfers).toHaveLength(2);
    expect(b.transfers[0]!.fromRouteIdx).toBe(0);
    expect(b.transfers[0]!.toRouteIdx).toBe(1);
    expect(b.transfers[0]!.fromTripIdx).toBeUndefined();
    expect(b.transfers[0]!.transferType).toBe(1);
    expect(b.transfers[1]!.fromTripIdx).toBe(0);
    expect(b.transfers[1]!.toTripIdx).toBe(1);
    expect(b.transfers[1]!.fromRouteIdx).toBeUndefined();
    expect(b.transfers[1]!.transferType).toBe(3);
  });

  it("a feed without transfers.txt decodes zero transfers", () => {
    const b = loadPtb(fixtureBuf());
    expect(b.transfers).toEqual([]);
    expect(b.regions.transfers.length).toBe(0);
  });
});

describe("loadPtb — current SoA identity layer", () => {
  it("decodes the current tagged region table and featureFlags", () => {
    const b = loadPtb(fixtureBufServicePool());
    expect(b.version).toBe(1);
    expect(b.featureFlags).toBe(0);
    expect(b.stringPool.length).toBeGreaterThan(0);
    expect(b.stopIndexRegion).toBeDefined();
    expect(b.stopIndexRegion!.length).toBeGreaterThan(0);
  });

  it("fnv1a32 matches the Rust collision corpus (cross-language hash parity)", () => {
    // "S2U9"/"AGCVF" are the verified fnv-1a32 collision pinned in
    // crates/pt-core/src/stop_index.rs (0xccc0c3b2). TS MUST agree byte-for-byte
    // or the persisted-StopIndex lookup diverges across the engine-regression gate.
    const h = (s: string) => fnv1a32(Buffer.from(s, "utf8"));
    expect(h("S2U9")).toBe(0xccc0c3b2);
    expect(h("AGCVF")).toBe(0xccc0c3b2);
    expect(h("S2U9")).toBe(h("AGCVF"));
  });
});

describe("loadPtb — current SoA columns", () => {
  const SRC_STOPS = [
    { stopId: "S0", stopName: "Alpha", lat: 54.69, lon: 25.28, latE7: 546900000, lonE7: 252800000, wc: 0 },
    { stopId: "S1", stopName: "Bravo", lat: 54.695, lon: 25.285, latE7: 546950000, lonE7: 252850000, wc: 1 },
    { stopId: "S2", stopName: "Charlie", lat: 54.7, lon: 25.29, latE7: 547000000, lonE7: 252900000, wc: 0 },
  ] as const;
  const SRC_ROUTES = [
    { routeId: "R0", agencyId: "AG", short: "0", long: "Route Zero", color: "FF0000", text: "FFFFFF", type: 3 },
  ] as const;

  it("captures the 0x40/0x41 SoA regions and the persisted StopIndex", () => {
    const b = loadPtb(fixtureBufServicePool());
    expect(b.version).toBe(1);
    expect(b.stopsSoaRegion.length).toBeGreaterThan(0);
    expect(b.routesSoaRegion.length).toBeGreaterThan(0);
    // The persisted StopIndex (0x44) is still emitted alongside the SoA columns.
    expect(b.stopIndexRegion).toBeDefined();
    expect(b.stopIndexRegion!.length).toBeGreaterThan(0);
  });

  it("decodes stop ids/names/wheelchair from the SoA columns", () => {
    const b = loadPtb(fixtureBufServicePool());
    expect(b.stops.map((s) => s.stopId)).toEqual(SRC_STOPS.map((s) => s.stopId));
    expect(b.stops.map((s) => s.stopName)).toEqual(SRC_STOPS.map((s) => s.stopName));
    expect(b.stops.map((s) => s.wheelchairBoarding)).toEqual(SRC_STOPS.map((s) => s.wc));
  });

  it("exposes canonical i32 latE7/lonE7 AND lazy f64 stopLat/stopLon", () => {
    const b = loadPtb(fixtureBufServicePool());
    b.stops.forEach((s, i) => {
      const src = SRC_STOPS[i]!;
      // Canonical i32 columns, bit-exact to the oracle-verified ground truth.
      expect(s.latE7, `stop[${i}].latE7`).toBe(src.latE7);
      expect(s.lonE7, `stop[${i}].lonE7`).toBe(src.lonE7);
      expect(Number.isInteger(s.latE7!), `stop[${i}].latE7 is int`).toBe(true);
      expect(Number.isInteger(s.lonE7!), `stop[${i}].lonE7 is int`).toBe(true);
      // f64 convenience coords within ~1e-7 deg of the f64 source.
      expect(Math.abs(s.stopLat - src.lat), `stop[${i}].stopLat`).toBeLessThan(1e-7);
      expect(Math.abs(s.stopLon - src.lon), `stop[${i}].stopLon`).toBeLessThan(1e-7);
    });
  });

  it("derives an empty stopParents table from u32::MAX parent sentinels", () => {
    expect(loadPtb(fixtureBufServicePool()).stopParents).toEqual([]);
  });

  it("decodes all six route idx columns incl agencyId/longName + route_type", () => {
    const b = loadPtb(fixtureBufServicePool());
    expect(b.routes).toEqual(
      SRC_ROUTES.map((r) => ({
        routeId: r.routeId,
        agencyId: r.agencyId,
        routeShortName: r.short,
        routeLongName: r.long,
        routeType: r.type,
        routeColor: r.color,
        routeTextColor: r.text,
      })),
    );
  });

  it("decodes the current SoA StopTimes columns", () => {
    const b = loadPtb(fixtureBufServicePool());
    expect(b.stopTimes.map((row) => row.depSecs)).toEqual([25200, 25500, 25800, 28800, 29400]);
    expect(b.stopTimes.map((row) => row.stopIdx)).toEqual([0, 1, 2, 0, 2]);
    expect(b.stopTimes.map((row) => row.stopSeq)).toEqual([1, 2, 3, 1, 2]);
    expect(b.stopTimes.every((row) => row.arrDiff === 0)).toBe(true);
  });

  it("persisted StopIndex resolves every id (parity with the eager Map)", () => {
    const buf = fixtureBufServicePool();
    const b = loadPtb(buf);
    const ref = new Map<string, number>();
    b.stops.forEach((s, i) => ref.set(s.stopId, i));
    for (const id of ["S0", "S1", "S2"]) {
      expect(lookupStopIndexRegion(buf, b.stopIndexRegion!, b.stringPool, id)).toBe(ref.get(id));
    }
    expect(lookupStopIndexRegion(buf, b.stopIndexRegion!, b.stringPool, "absent")).toBeUndefined();
  });

  // ---- negative: a corrupt parent_idx column must THROW (mirrors the Rust guards
  //      in reader.rs stop_parent / validate_structural + the ported loader throws) ----
  // Locate StopsSoA 0x40 in the current tagged table (24 B entries from offset 32;
  // regionId u16 @+0, offset u64 @+8). parent_idx is the 5th u32 column → starts
  // at region_offset + 16*N (N=3 stops); element i at +i*4.
  const tamperParentIdx = (child: number, value: number): Buffer => {
    const buf = Buffer.from(fixtureBufServicePool()); // mutable copy
    const n = loadPtb(buf).stops.length;
    let off = -1;
    for (let e = 32; ; e += 24) {
      const id = buf.readUInt16LE(e);
      if (id === 0) throw new Error("0x40 region not found");
      if (id === 0x40) { off = Number(buf.readBigUInt64LE(e + 8)); break; }
    }
    buf.writeUInt32LE(value >>> 0, off + 16 * n + child * 4);
    return buf;
  };

  it("throws on an out-of-range parent_idx (>= numStops)", () => {
    // S1 (child idx 1): u32::MAX -> 99 (>= N=3) is out of range.
    expect(() => loadPtb(tamperParentIdx(1, 99))).toThrow();
  });

  it("throws on a self-referential parent_idx (parent === child)", () => {
    // S1 (child idx 1): u32::MAX -> 1 (== own index) is a self-parent.
    expect(() => loadPtb(tamperParentIdx(1, 1))).toThrow();
  });
});

describe("loadPtb — current boarding semantics", () => {
  it("leaves boarding absent when a current bundle has no non-default semantics", () => {
    expect(loadPtb(fixtureBufServicePool()).boarding).toBeUndefined();
  });

  it("materializes pickup semantics from a carry-less PTB v1 band", () => {
    const bundle = loadPtb(frontendFixtureBuf("board-forbid.ptb"));
    expect(bundle.version).toBe(1);
    expect(Array.from(bundle.boarding ?? [])).toEqual([0x50, 0x51, 0x50]);
  });

  it("materializes drop-off and permissive pickup semantics from PTB v1 bands", () => {
    const alight = loadPtb(frontendFixtureBuf("alight-forbid.ptb"));
    const pickupTwo = loadPtb(frontendFixtureBuf("pickup-two-three-ok.ptb"));
    expect(Array.from(alight.boarding ?? [])).toEqual([0x50, 0x54, 0x50]);
    expect(Array.from(pickupTwo.boarding ?? [])).toEqual([0x50, 0x52, 0x50]);
  });
});

describe("ptb 0x17 Frequencies region", () => {
  // Wire layout: count u32 LE + count × 16 B rows, each row:
  //   [0..4]  tripIdx     u32 LE
  //   [4..8]  startSecs   u32 LE
  //   [8..12] endSecs     u32 LE  (half-open, carried verbatim)
  //   [12..14] headwaySecs u16 LE
  //   [14]    exactTimes  u8
  //   [15]    reserved    u8
  const ENTRY = 24;

  const frequencyBodyOffset = (buf: Buffer): number => {
    for (let e = 32; ; e += ENTRY) {
      const id = buf.readUInt16LE(e);
      if (id === FREQUENCIES_REGION_ID) return Number(buf.readBigUInt64LE(e + 8));
      if (id === 0) throw new Error("0x17 Frequencies region not found");
    }
  };

  it("decodes the 0x17 Frequencies column (absent ⇒ undefined; present ⇒ rows)", () => {
    const absent = loadPtb(fixtureBufServicePool());
    expect(absent.frequencies).toBeUndefined();

    expect(loadPtb(fixtureBufFrequencies()).frequencies).toEqual([
      { tripIdx: 0, startSecs: 21600, endSecs: 86400, headwaySecs: 600, exactTimes: 0 },
      { tripIdx: 0, startSecs: 86400, endSecs: 108000, headwaySecs: 1800, exactTimes: 1 },
      { tripIdx: 1, startSecs: 36000, endSecs: 72000, headwaySecs: 900, exactTimes: 0 },
    ]);
  });

  it("carries endSecs verbatim (half-open, not adjusted)", () => {
    // endSecs is the half-open EXCLUDED bound per the GTFS spec; the loader
    // must not add/subtract 1 or otherwise interpret it — carry verbatim.
    expect(loadPtb(fixtureBufFrequencies()).frequencies![1]!.endSecs).toBe(108000);
  });

  it("rejects a 0x17 region whose length != 4 + count * 16", () => {
    const buf = Buffer.from(fixtureBufFrequencies());
    buf.writeUInt32LE(4, frequencyBodyOffset(buf)); // committed body holds 3 rows
    expect(() => loadPtb(buf)).toThrow(/frequencies/);
  });
});

describe("ptb 0x01 WindowMeta + runtime service-bitmask stride", () => {
  // WindowMeta is a little-endian u16 `windowDays` at byte 0 (+ optional reserved
  // tail). Default when absent: 90 ⇒ stride ceil(90/8)=12. Hard ceiling 400;
  // present-but-<2B ⇒ throw.
  const WINDOW_META_REGION_ID = 0x01;
  const ENTRY = 24;

  const windowEntryOffset = (buf: Buffer): number => {
    for (let e = 32; ; e += ENTRY) {
      const id = buf.readUInt16LE(e);
      if (id === WINDOW_META_REGION_ID) return e;
      if (id === 0) throw new Error("0x01 WindowMeta region not found");
    }
  };

  it("defaults windowDays to 90 (stride 12) when 0x01 is absent", () => {
    const b = loadPtb(fixtureBufServicePool());
    expect(b.version).toBe(1);
    expect(b.windowDays).toBe(90);
  });

  it("decodes windowDays=400 from a current v1 fixture with stride 50", () => {
    const b = loadPtb(fixtureBufWindow400());
    expect(b.version).toBe(1);
    expect(b.windowDays).toBe(400);
  });

  it("throws on a present-but-1-byte 0x01 region (malformed, must not masquerade as absent)", () => {
    const buf = Buffer.from(fixtureBufWindow400());
    buf.writeBigUInt64LE(1n, windowEntryOffset(buf) + 16);
    expect(() => loadPtb(buf)).toThrow();
  });

  it("throws on windowDays=401 (over the 400 hard ceiling)", () => {
    const buf = Buffer.from(fixtureBufWindow400());
    const entry = windowEntryOffset(buf);
    buf.writeUInt16LE(401, Number(buf.readBigUInt64LE(entry + 8)));
    expect(() => loadPtb(buf)).toThrow();
  });

  // ── readWindowProvenance: the cheap, TOTAL header-only decode (no Buffer) ──
  const u8 = (buf: Buffer): Uint8Array => new Uint8Array(buf);

  it("readWindowProvenance: default 90 + feedStartDate when 0x01 is absent", () => {
    const current = fixtureBufServicePool();
    const p = readWindowProvenance(u8(current));
    expect(p.windowDays).toBe(SERVICE_WINDOW_DAYS);
    expect(p.windowDays).toBe(90);
    expect(p.feedStartDate).toBe(loadPtb(current).feedStartDate);
  });

  it("readWindowProvenance: decodes windowDays=400 from a 0x01 region (matches loadPtb)", () => {
    const current = fixtureBufWindow400();
    const p = readWindowProvenance(u8(current));
    expect(p.windowDays).toBe(400);
    expect(p.windowDays).toBe(loadPtb(current).windowDays);
  });

  it("readWindowProvenance: is TOTAL — non-PTB / too-short bytes degrade to defaults, never throw", () => {
    // The byte-persist path must not break when handed garbage (e.g. the
    // 4-byte placeholder fixtures the gtfsBundleBytes tests use).
    expect(readWindowProvenance(new Uint8Array([0x50, 0x54, 0x42, 0x00]))).toEqual({
      windowDays: SERVICE_WINDOW_DAYS,
      feedStartDate: 0,
    });
    expect(readWindowProvenance(new Uint8Array(0))).toEqual({
      windowDays: SERVICE_WINDOW_DAYS,
      feedStartDate: 0,
    });
    expect(readWindowProvenance(new Uint8Array([1, 2, 3, 4, 5]))).toEqual({
      windowDays: SERVICE_WINDOW_DAYS,
      feedStartDate: 0,
    });
  });
});

describe("ptb v1 ServiceBitfieldPool (0x15) + ServiceToBitfield (0x16)", () => {
  // The current layout stores distinct day-vectors in 0x15 and maps each service
  // to a pool slot through 0x16. The loader materializes the stable flat
  // `numServices × S` view consumed by TypeScript callers. Both regions are
  // mandatory, lengths are exact, every index is bounded by the pool count, and
  // count==0 iff numServices==0.
  const SERVICE_BITFIELD_POOL_REGION_ID = 0x15;
  const SERVICE_TO_BITFIELD_REGION_ID = 0x16;
  const ENTRY = 24;
  const S = 12; // bytes/service for the default windowDays=90 (ceil(90/8))

  const region = (buf: Buffer, wanted: number) => {
    for (let e = 32; ; e += ENTRY) {
      const id = buf.readUInt16LE(e);
      if (id === wanted) {
        return {
          entry: e,
          offset: Number(buf.readBigUInt64LE(e + 8)),
          length: Number(buf.readBigUInt64LE(e + 16)),
        };
      }
      if (id === 0) throw new Error(`region 0x${wanted.toString(16)} not found`);
    }
  };

  const hideRegion = (src: Buffer, id: number, replacement: number): Buffer => {
    const out = Buffer.from(src);
    out.writeUInt16LE(replacement, region(out, id).entry);
    return out;
  };

  it("loads the current v1 fixture and materializes pool indices [0, 1, 0]", () => {
    const buf = fixtureBufServicePool();
    const pool = region(buf, SERVICE_BITFIELD_POOL_REGION_ID);
    const index = region(buf, SERVICE_TO_BITFIELD_REGION_ID);
    expect(buf.readUInt32LE(pool.offset)).toBe(2);
    expect([0, 1, 2].map((i) => buf.readUInt32LE(index.offset + i * 4))).toEqual([0, 1, 0]);

    const b = loadPtb(buf);
    expect(b.version).toBe(1);
    expect(b.numServices).toBe(3);
    expect(b.serviceBitmasks.length).toBe(3 * S);
    expect(Array.from(b.serviceBitmasks.subarray(0, S))).toEqual(
      Array.from(buf.subarray(pool.offset + 4, pool.offset + 4 + S)),
    );
    expect(Array.from(b.serviceBitmasks.subarray(S, 2 * S))).toEqual(
      Array.from(buf.subarray(pool.offset + 4 + S, pool.offset + 4 + 2 * S)),
    );
    expect(Array.from(b.serviceBitmasks.subarray(2 * S, 3 * S))).toEqual(
      Array.from(buf.subarray(pool.offset + 4, pool.offset + 4 + S)),
    );
  });

  it("C3: throws when 0x15 is present but 0x16 is absent", () => {
    expect(() =>
      loadPtb(
        hideRegion(fixtureBufServicePool(), SERVICE_TO_BITFIELD_REGION_ID, 0x7f01),
      ),
    ).toThrow();
  });

  it("C3: throws when 0x16 is present but 0x15 is absent", () => {
    expect(() =>
      loadPtb(
        hideRegion(fixtureBufServicePool(), SERVICE_BITFIELD_POOL_REGION_ID, 0x7f00),
      ),
    ).toThrow();
  });

  it("C3: throws when both 0x15 and 0x16 are absent", () => {
    const withoutPool = hideRegion(fixtureBufServicePool(), SERVICE_BITFIELD_POOL_REGION_ID, 0x7f00);
    expect(() => loadPtb(hideRegion(withoutPool, SERVICE_TO_BITFIELD_REGION_ID, 0x7f01))).toThrow();
  });

  it("C2: throws when count==0 but numServices>0 (empty pool, services to map)", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const pool = region(buf, SERVICE_BITFIELD_POOL_REGION_ID);
    buf.writeUInt32LE(0, pool.offset);
    buf.writeBigUInt64LE(4n, pool.entry + 16);
    expect(() => loadPtb(buf)).toThrow();
  });

  it("C2: count==0 && numServices==0 is OK", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const pool = region(buf, SERVICE_BITFIELD_POOL_REGION_ID);
    const index = region(buf, SERVICE_TO_BITFIELD_REGION_ID);
    buf.writeUInt32LE(0, 24);
    buf.writeUInt32LE(0, pool.offset);
    buf.writeBigUInt64LE(4n, pool.entry + 16);
    buf.writeBigUInt64LE(0n, index.entry + 16);
    const b = loadPtb(buf);
    expect(b.numServices).toBe(0);
    expect(b.serviceBitmasks.length).toBe(0);
  });

  it("exact-length: throws when 0x15 length != 4 + count*S", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const pool = region(buf, SERVICE_BITFIELD_POOL_REGION_ID);
    buf.writeUInt32LE(3, pool.offset); // committed body holds only two bitfields
    expect(() => loadPtb(buf)).toThrow();
  });

  it("exact-length: throws when 0x16 length != numServices*4", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const index = region(buf, SERVICE_TO_BITFIELD_REGION_ID);
    buf.writeBigUInt64LE(BigInt(index.length - 4), index.entry + 16);
    expect(() => loadPtb(buf)).toThrow();
  });

  it("index-bounds: throws when a 0x16 entry is >= count (out of range)", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const index = region(buf, SERVICE_TO_BITFIELD_REGION_ID);
    buf.writeUInt32LE(2, index.offset); // committed pool count is 2
    expect(() => loadPtb(buf)).toThrow();
  });

  // C2 (converse): the count==0 IFF numServices==0 biconditional must reject the
  // OTHER asymmetry too — numServices==0 && count>0 is an ORPHANED pool (non-empty
  // bitfield storage no ServiceToBitfield entry can point at). Mirrors the Rust
  // reader's `(count == 0) != (num_services == 0)` gate.
  it("C2 converse: throws when numServices==0 but count>0 (orphan pool)", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const index = region(buf, SERVICE_TO_BITFIELD_REGION_ID);
    buf.writeUInt32LE(0, 24);
    buf.writeBigUInt64LE(0n, index.entry + 16);
    expect(() => loadPtb(buf)).toThrow();
  });
});

// The TypeScript tagged-table scan must mirror the Rust `Header::parse`
// table walk (crates/pt-core/src/header.rs) — cap at PTB_HEADER_BYTES (4096),
// reject duplicate regionIds (`dup_region_id`), and reject an unterminated table
// (no `regionId==0` within the header prefix, `unterminated`).
describe("ptb v1 tagged-table scan parity with Rust Header::parse", () => {
  const SERVICE_BITFIELD_POOL_REGION_ID = 0x15;
  const SERVICE_TO_BITFIELD_REGION_ID = 0x16;
  const ENTRY = 24;
  const HEADER_BYTES = 4096;

  const entryOffset = (buf: Buffer, wanted: number): number => {
    for (let e = 32; ; e += ENTRY) {
      const id = buf.readUInt16LE(e);
      if (id === wanted) return e;
      if (id === 0) throw new Error(`region 0x${wanted.toString(16)} not found`);
    }
  };

  const terminatorOffset = (buf: Buffer): number => {
    for (let e = 32; e + ENTRY <= HEADER_BYTES; e += ENTRY) {
      if (buf.readUInt16LE(e) === 0) return e;
    }
    throw new Error("tagged table has no terminator");
  };

  const appendDuplicate = (src: Buffer, regionId: number): Buffer => {
    const out = Buffer.from(src);
    const source = entryOffset(out, regionId);
    const terminator = terminatorOffset(out);
    out.copy(out, terminator, source, source + ENTRY);
    out.writeUInt16LE(0, terminator + ENTRY);
    return out;
  };

  it("throws on a DUPLICATE 0x15 ServiceBitfieldPool entry (dup_region_id)", () => {
    expect(() =>
      loadPtb(appendDuplicate(fixtureBufServicePool(), SERVICE_BITFIELD_POOL_REGION_ID)),
    ).toThrow(/duplicate|dup/i);
  });

  it("throws on a DUPLICATE 0x16 ServiceToBitfield entry (dup_region_id)", () => {
    expect(() =>
      loadPtb(appendDuplicate(fixtureBufServicePool(), SERVICE_TO_BITFIELD_REGION_ID)),
    ).toThrow(/duplicate|dup/i);
  });

  it("throws on an UNTERMINATED tagged table (entries fill past PTB_HEADER_BYTES)", () => {
    const buf = Buffer.from(fixtureBufServicePool());
    const terminator = terminatorOffset(buf);
    let fillerId = 0x7000;
    for (let e = terminator; e + ENTRY <= HEADER_BYTES; e += ENTRY) {
      buf.fill(0, e, e + ENTRY);
      buf.writeUInt16LE(fillerId++, e);
    }
    expect(() => loadPtb(buf)).toThrow();
  });

  it("loads the well-formed current v1 fixture under the strict table scan", () => {
    expect(loadPtb(fixtureBufServicePool()).version).toBe(1);
  });
});

describe("ptb v1 (current PTB layout)", () => {
  // pattern-band-tiny.ptb is committed as the current PTB v1 source of
  // truth. Mirrors the Rust reader checkpoint at
  // crates/pt-core/tests/ptb_v1_alias.rs, which reads the same committed
  // fixture directly.
  function findRepoRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny.ptb"))) return dir;
      dir = resolve(dir, "..");
    }
    throw new Error("ptb v1: could not locate repo root from " + process.cwd());
  }
  const BAND_PTB = resolve(
    findRepoRoot(),
    "packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb",
  );

  it("loads the committed pattern-band-tiny.ptb as v1 with the current-layout facts pinned", () => {
    const buf = readFileSync(BAND_PTB);
    expect(buf.readUInt16LE(4)).toBe(1);

    const bundle = loadPtb(buf);
    expect(bundle.version).toBe(1);
    expect(bundle.stops.length).toBe(5);
    expect(bundle.routes.length).toBe(1);
    expect(bundle.trips.length).toBe(5);
    expect(bundle.numServices).toBe(1);

    expect(bundle.patternBand).toBeDefined();
    expect(bundle.patternBand!.numPatterns).toBe(3);
    expect(bundle.carryMaterializedFromBand).toBe(true);

    expect(bundle.stopTimes.length).toBe(21);
    expect(Array.from(bundle.tripStarts)).toEqual([0, 4, 8, 13, 17, 21]);
    expect(Array.from(bundle.routeTripsOffsets)).toEqual([0, 5]);
    expect(Array.from(bundle.routeTripsValues)).toEqual([0, 1, 2, 3, 4]);
  });

  it("readWindowProvenance reports the loaded v1 bundle's own feedStartDate/windowDays", () => {
    const buf = readFileSync(BAND_PTB);
    const bundle = loadPtb(buf);

    const provenance = readWindowProvenance(new Uint8Array(buf));
    expect(provenance.feedStartDate).toBe(bundle.feedStartDate);
    expect(provenance.windowDays).toBe(bundle.windowDays);
  });
});
