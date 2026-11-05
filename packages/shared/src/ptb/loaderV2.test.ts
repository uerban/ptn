/**
 * PTB v2 reader tests.
 *
 * `tiny-v2.ptb` is the Rust producer's own v2 staging output for the synthetic
 * feed in `crates/pt-producer/tests/ptb_v2_stage.rs`, which also pins these
 * bytes (regenerate with `PTN_REGEN_V2_FIXTURE=1 cargo test -p pt-producer
 * --test ptb_v2_stage`). Synthetic feed only, not a real city feed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPtb, readWindowProvenance } from "./loader.js";
import { ptbBundleToWire } from "./ptbToBundleWire.js";

const v2Buf = (): Buffer => readFileSync(new URL("./__fixtures__/tiny-v2.ptb", import.meta.url));

/** Offset of the tagged region-table entry for `regionId` (24 B entries @32). */
function entryOffset(buf: Buffer, regionId: number): number {
  for (let e = 32; e + 24 <= 4096; e += 24) {
    const id = buf.readUInt16LE(e);
    if (id === 0) break;
    if (id === regionId) return e;
  }
  throw new Error(`region 0x${regionId.toString(16)} not in table`);
}
const regionOffset = (buf: Buffer, id: number): number => Number(buf.readBigUInt64LE(entryOffset(buf, id) + 8));

describe("loadPtb — PTB v2", () => {
  it("decodes the v2 header, origins and commitments", () => {
    const b = loadPtb(v2Buf());
    expect(b.version).toBe(2);
    expect(b.feedStartDate).toBe(20260502);
    const v2 = b.v2!;
    expect(v2.deriveBlockInseat).toBe(true);
    expect(v2.serviceDayOrigins).toHaveLength(b.windowDays + 1);
    // 2026-05-02 noon CEST (10:00Z) minus 12 h = 2026-05-01T22:00:00Z.
    expect(v2.serviceDayOrigins[0]).toBe(1_777_672_800);
    expect(v2.serviceDayOrigins[1]! - v2.serviceDayOrigins[0]!).toBe(86_400);
    expect(v2.blockDerivationCommitment).toEqual({
      algorithmVersion: 1,
      pairDateCount: 0,
      tuplesSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(v2.compatibilityArtifactCommitment.v1IdentitySize).toBeGreaterThan(0);
    expect(v2.compatibilityArtifactCommitment.v1IdentitySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips a stopless linked transfer and keeps stop-keyed rows intact", () => {
    const b = loadPtb(v2Buf());
    const [linked, station, blocked] = b.transfers;
    expect(linked).toEqual({ transferType: 4, fromTripIdx: 0, toTripIdx: 1 });
    expect(linked!.fromStopIdx).toBeUndefined();
    expect(station).toEqual({ transferType: 2, fromStopIdx: 4, toStopIdx: 4, minTransferSecs: 90 });
    expect(blocked).toEqual({ transferType: 3, fromStopIdx: 3, toStopIdx: 0 });
  });

  it("carries absent stop ids through the wire converter without inventing them", () => {
    const wire = ptbBundleToWire(loadPtb(v2Buf()));
    const linked = wire.transfers![0]!;
    expect(linked).toEqual({ transferType: 4, fromTripId: "T1", toTripId: "T2" });
    expect("fromStopId" in linked).toBe(false);
    expect(wire.transfers![1]).toMatchObject({ fromStopId: "ST", toStopId: "ST" });
  });

  it("keeps quarantined frequency trips out of the frequency rows and the routing wire", () => {
    const b = loadPtb(v2Buf());
    expect(b.trips.map((t) => t.tripId)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(b.v2!.quarantinedFrequencyTrips).toEqual([4]);
    expect(b.frequencies).toEqual([
      { tripIdx: 3, startSecs: 43200, endSecs: 46799, headwaySecs: 1200, exactTimes: 1 },
    ]);
    const wire = ptbBundleToWire(b);
    const tripIds = wire.routes.flatMap((r) => r.trips.map((t) => t.tripId));
    expect(tripIds).toContain("T4");
    expect(tripIds).not.toContain("T5");
  });

  it("fails closed on v2 frequency rows that break the contract", () => {
    const freq = (buf: Buffer): number => regionOffset(buf, 0x17) + 4;
    const flags = v2Buf();
    flags.writeUInt8(2, freq(flags) + 15);
    expect(() => loadPtb(flags)).toThrow(/unknown_flags/);
    const onDeparture = v2Buf();
    // T4: 12:00 + 3 * 1200 s = 13:00 exactly, an exact_times=1 end on a
    // departure. The window end is exclusive, so the row stays healthy.
    onDeparture.writeUInt32LE(46800, freq(onDeparture) + 8);
    expect(loadPtb(onDeparture).frequencies).toContainEqual({
      tripIdx: 3, startSecs: 43200, endSecs: 46800, headwaySecs: 1200, exactTimes: 1,
    });
    const marker = v2Buf();
    marker.writeUInt32LE(5, freq(marker) + 16 + 8);
    expect(() => loadPtb(marker)).toThrow(/noncanonical_quarantine_marker/);
    // pt_core rejects a row naming a trip past numTrips; so must this reader.
    const outOfRange = v2Buf();
    outOfRange.writeUInt32LE(outOfRange.readUInt32LE(16), freq(outOfRange) + 16);
    expect(() => loadPtb(outOfRange)).toThrow(/trip_out_of_range/);
  });

  it("reads window provenance from a v2 header like loadPtb does", () => {
    const buf = v2Buf();
    const b = loadPtb(buf);
    expect(readWindowProvenance(new Uint8Array(buf))).toEqual({
      windowDays: b.windowDays,
      feedStartDate: b.feedStartDate,
    });
    expect(b.feedStartDate).toBeGreaterThan(0);
  });

  it("rejects a v2 TripMeta block_idx past the string pool", () => {
    const buf = v2Buf();
    buf.writeUInt32LE(0x7ffffff0, regionOffset(buf, 0x14) + 16);
    expect(() => loadPtb(buf)).toThrow(/block_idx .* out of range/);
  });

  it("rejects unknown v2 featureFlags bits", () => {
    const buf = v2Buf();
    buf.writeUInt16LE(buf.readUInt16LE(6) | (1 << 3), 6);
    expect(() => loadPtb(buf)).toThrow(/unknown bits/);
  });

  it("fails closed on a missing or malformed v2 region", () => {
    const missing = v2Buf();
    // Retag 0x1A to an unknown id: the reader must not treat it as absent-ok.
    missing.writeUInt16LE(0x7e, entryOffset(missing, 0x1a));
    expect(() => loadPtb(missing)).toThrow(/compatibilityArtifactCommitment/);

    const decreasing = v2Buf();
    const o = regionOffset(decreasing, 0x18);
    decreasing.writeBigInt64LE(decreasing.readBigInt64LE(o), o + 8);
    expect(() => loadPtb(decreasing)).toThrow(/strictly increasing/);

    const unsafe = v2Buf();
    unsafe.writeBigInt64LE(1n << 60n, regionOffset(unsafe, 0x18) + 8 * 5);
    expect(() => loadPtb(unsafe)).toThrow(/safe integer/);

    const algo = v2Buf();
    algo.writeUInt16LE(2, regionOffset(algo, 0x19));
    expect(() => loadPtb(algo)).toThrow(/unknown algorithm/);

    const disabled = v2Buf();
    // Clearing DERIVE_BLOCK_INSEAT leaves an empty commitment, which is valid.
    disabled.writeUInt16LE(disabled.readUInt16LE(6) & ~(1 << 2), 6);
    expect(loadPtb(disabled).v2!.deriveBlockInseat).toBe(false);
    const nonEmpty = Buffer.from(disabled);
    nonEmpty.writeBigUInt64LE(1n, regionOffset(nonEmpty, 0x19) + 8);
    expect(() => loadPtb(nonEmpty)).toThrow(/must be empty/);
  });

  it("distinguishes an absent stop from an out-of-range one and rejects stopless ordinary rows", () => {
    const tr = (buf: Buffer): number => regionOffset(buf, 0xf8);
    const stopless = v2Buf();
    // Row 2 (type 3) loses its from_stop: ordinary rows must keep both stops.
    stopless.writeUInt32LE(0xffffffff, tr(stopless) + 2 * 32);
    expect(() => loadPtb(stopless)).toThrow(/stopless_ordinary/);

    const outOfRange = v2Buf();
    outOfRange.writeUInt32LE(99, tr(outOfRange) + 2 * 32);
    expect(() => loadPtb(outOfRange)).toThrow(/stop_out_of_range/);

    const tripless = v2Buf();
    tripless.writeUInt32LE(0xffffffff, tr(tripless) + 16);
    expect(() => loadPtb(tripless)).toThrow(/linked_without_trips/);

    const reserved = v2Buf();
    reserved.writeUInt8(1, tr(reserved) + 30);
    expect(() => loadPtb(reserved)).toThrow(/reserved_nonzero/);
  });

  it("still rejects every version other than 1 and 2", () => {
    const buf = v2Buf();
    buf.writeUInt16LE(3, 4);
    expect(() => loadPtb(buf)).toThrow(/unsupported version 3/);
  });
});
