/**
 * B1.3 Task A — cross-impl decode-parity test for the v1 pattern band.
 *
 * Loads the Rust-built committed `pattern-band-tiny.ptb` (single route, five
 * trips, three patterns A=[0,1,2,4] / B=[0,1,3,4] / C=[0,1,2,1,4] (lasso)) and
 * asserts the TS `decodePatternBand` mirror reproduces the Rust
 * `resolve_pattern_band` decode AND the normative `groupTripsByPattern(.,
 * Unbounded)` enumeration (the equivalence anchor — the band IS the grouping).
 *
 * The fixture is committed under packages/frontend/tests/services/__fixtures__
 * by the Rust emitter, so we locate it via the repo-root walk that
 * crates/pt-core/tests/raptor_behavior.rs uses.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodePatternBand,
  loadPtb,
  resolvePatternBandRegions,
  type PtbPatternBand,
} from "./loader.js";
import { groupTripsByPattern, type TripForGrouping } from "../raptor/patternSignature.js";
import { PatternMode } from "../raptor/patternMode.js";

// ── Locate the repo root (holds the committed Rust-built band fixture) ─────────
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny.ptb"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  throw new Error("patternBandDecode: could not locate repo root from " + process.cwd());
}
const REPO_ROOT = findRepoRoot();
const BAND_PTB = resolve(
  REPO_ROOT,
  "packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb",
);
// Current PTB v1 service-pool bundle without a pattern band.
const SERVICE_POOL_PTB = new URL("./__fixtures__/tiny-service-pool.ptb", import.meta.url);

const loadBand = (): Buffer => readFileSync(BAND_PTB);

/** Decode the band directly from raw fixture bytes (mirrors the loadPtb call). */
function decodeBandFromFixture(buf: Buffer): PtbPatternBand {
  const bundle = loadPtb(buf);
  const bands = resolvePatternBandRegions(buf);
  const band = decodePatternBand(buf, bands, bundle.stops.length, bundle.trips.length);
  if (!band) throw new Error("expected a pattern band on the v1 fixture");
  return band;
}

/** Re-resolve band regions from a (possibly corrupted) buffer + decode. */
function decodeFrom(buf: Buffer): PtbPatternBand | undefined {
  const bundle = loadPtb(buf);
  const bands = resolvePatternBandRegions(buf);
  return decodePatternBand(buf, bands, bundle.stops.length, bundle.trips.length);
}

/** This pattern's stop-idx sequence (repeats preserved), from the 0x11 column. */
function patternStops(band: PtbPatternBand, p: number): number[] {
  const rec = band.patterns[p]!;
  return Array.from(
    band.patternStops.subarray(rec.stopsOff, rec.stopsOff + rec.stopCount),
  );
}

/** CSR slice [offsets[i], offsets[i+1]) of a {offsets, values} pair as an array. */
function csrSlice(offsets: Uint32Array, values: Uint32Array, i: number): number[] {
  return Array.from(values.subarray(offsets[i]!, offsets[i + 1]!));
}

/**
 * Build the route_trips-ordered `TripForGrouping[]` from the FLAT carry: each
 * trip's stop-idx sequence is its `stopTimes` slice (tripStarts prefix-sum),
 * iterated in `routeTripsValues` order. This is the INDEPENDENT decode the
 * equivalence anchor folds against (NOT a second band read).
 */
function tripsFromFlatCarry(buf: Buffer): TripForGrouping[] {
  const b = loadPtb(buf);
  const out: TripForGrouping[] = [];
  for (const tripIdx of Array.from(b.routeTripsValues)) {
    const lo = b.tripStarts[tripIdx]!;
    const hi = b.tripStarts[tripIdx + 1]!;
    const stopIdxs: number[] = [];
    for (let r = lo; r < hi; r++) stopIdxs.push(b.stopTimes[r]!.stopIdx);
    out.push({ tripIdx, stopIdxs });
  }
  return out;
}

describe("decodePatternBand — pattern-band-tiny.ptb (v1)", () => {
  it("(a) decodes the 3 patterns with exact stop sequences incl. the lasso repeat", () => {
    const band = decodeBandFromFixture(loadBand());
    expect(band.numPatterns).toBe(3);
    expect(band.patterns).toHaveLength(3);
    // First-appearance enumeration order over route_trips: A (trip0), B (trip1),
    // C (trip2, lasso with repeated s1).
    expect(patternStops(band, 0)).toEqual([0, 1, 2, 4]);
    expect(patternStops(band, 1)).toEqual([0, 1, 3, 4]);
    expect(patternStops(band, 2)).toEqual([0, 1, 2, 1, 4]); // lasso: s1 twice
  });

  it("(b) the decoded enumeration equals groupTripsByPattern(flat carry, Unbounded)", () => {
    const buf = loadBand();
    const band = decodeBandFromFixture(buf);
    const groups = groupTripsByPattern(tripsFromFlatCarry(buf), PatternMode.Unbounded);

    // Same pattern count + identical per-pattern stop-idx sequence (order incl.).
    expect(band.numPatterns).toBe(groups.length);
    for (let p = 0; p < groups.length; p++) {
      expect(patternStops(band, p)).toEqual(groups[p]!.stopIdxs);
    }
    // Same per-pattern member trip set (the 0x46 CSR vs the grouping's tripIdxs).
    for (let p = 0; p < groups.length; p++) {
      const bandTrips = csrSlice(band.patternTripsOffsets, band.patternTripsValues, p);
      expect([...bandTrips].sort((a, c) => a - c)).toEqual(
        [...groups[p]!.tripIdxs].sort((a, c) => a - c),
      );
    }
  });

  it("(c) 0x46 membership + 0x45 patterns-at-stop match the topology", () => {
    const band = decodeBandFromFixture(loadBand());
    // 0x46 PatternTrips: pattern A = trips {0,3,4}; B = {1}; C = {2}.
    expect(csrSlice(band.patternTripsOffsets, band.patternTripsValues, 0).sort((a, c) => a - c)).toEqual([
      0, 3, 4,
    ]);
    expect(csrSlice(band.patternTripsOffsets, band.patternTripsValues, 1)).toEqual([1]);
    expect(csrSlice(band.patternTripsOffsets, band.patternTripsValues, 2)).toEqual([2]);

    // 0x45 PatternsAtStop: each pattern serves the stops in its sequence; a stop's
    // pattern set is the set of patterns whose 0x11 sequence contains it.
    const numStops = 5;
    const expectedAtStop: number[][] = Array.from({ length: numStops }, () => []);
    for (let p = 0; p < band.numPatterns; p++) {
      for (const s of new Set(patternStops(band, p))) expectedAtStop[s]!.push(p);
    }
    for (let s = 0; s < numStops; s++) {
      const got = csrSlice(band.patternsAtStopOffsets, band.patternsAtStopValues, s);
      expect([...got].sort((a, c) => a - c)).toEqual(expectedAtStop[s]!.sort((a, c) => a - c));
    }
  });

  it("dense 0x13 TripTimes: entry_flags is the dense default (0)", () => {
    const band = decodeBandFromFixture(loadBand());
    expect(band.tripTimesEntryFlags).toBe(0);
  });

  it("copies a present 0x12 PatternSemantics region from Uint8Array bytes", () => {
    const source = loadBand();
    const bundle = loadPtb(source);
    const bands = resolvePatternBandRegions(source);
    const patterns = bands.patterns!;
    const semantics = Buffer.from([0x50, 0x51, 0x52, 0x53]);
    const bytes = Buffer.concat([source, semantics]);

    // Make pattern 0 non-all-regular so it consumes one semantics byte per
    // position. The fixture's first pattern has four stops.
    bytes.writeUInt16LE(0, patterns.offset + 4 + 6);
    const decoded = decodePatternBand(
      bytes,
      {
        ...bands,
        patternSemantics: {
          offset: source.length,
          length: semantics.length,
          entryFlags: 0,
        },
      },
      bundle.stops.length,
      bundle.trips.length,
    );

    expect(Array.from(decoded!.patternSemantics!)).toEqual(Array.from(semantics));
  });
});

describe("decodePatternBand — absent band", () => {
  it("(d) a service-pool bundle without 0x10 returns undefined", () => {
    const buf = readFileSync(SERVICE_POOL_PTB);
    const bundle = loadPtb(buf);
    expect(bundle.version).toBe(1);
    expect(decodeFrom(buf)).toBeUndefined();
    // loadPtb leaves patternBand unset when the region is absent.
    expect(bundle.patternBand).toBeUndefined();
  });

  it("loadPtb attaches patternBand on the v1 band fixture", () => {
    const bundle = loadPtb(loadBand());
    expect(bundle.version).toBe(1);
    expect(bundle.patternBand).toBeDefined();
    expect(bundle.patternBand!.numPatterns).toBe(3);
  });
});

describe("decodePatternBand — fail-closed gates", () => {
  it("a present 0x10 with a missing companion (0x46 zeroed) throws", () => {
    // Corrupt the region table in-memory: zero the 0x46 PatternTrips entry's
    // regionId so the companion resolves as absent → the band is malformed.
    const buf = Buffer.from(loadBand());
    // The tagged table starts at byte 32, 24 B entries, regionId u16 @ +0.
    const TABLE_OFF = 32;
    const ENTRY = 24;
    let zeroed = false;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === 0x46) {
        buf.writeUInt16LE(0xffff, e); // re-tag as an unknown id ⇒ 0x46 absent
        zeroed = true;
        break;
      }
    }
    expect(zeroed).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ptb:/);
  });

  it("a truncated 0x14 TripMeta length throws (length != numTrips*24)", () => {
    const buf = Buffer.from(loadBand());
    const TABLE_OFF = 32;
    const ENTRY = 24;
    let patched = false;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === 0x14) {
        // length u64 @ +16; shrink by 24 (one record) → != numTrips*24.
        const len = Number(buf.readBigUInt64LE(e + 16));
        buf.writeBigUInt64LE(BigInt(len - 24), e + 16);
        patched = true;
        break;
      }
    }
    expect(patched).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ptb:.*[Tt]ripMeta/);
  });

  it("a 0x13 TripTimes ragged entryFlags variant (bit0) throws (deferred on-ramp)", () => {
    // Note: bit0 alone makes the region length disagree with the i16 span (the
    // fixture's bytes are i16), so the dedicated ragged reject must fire FIRST —
    // we assert the ragged-specific message, not a length mismatch.
    const buf = Buffer.from(loadBand());
    const TABLE_OFF = 32;
    const ENTRY = 24;
    let patched = false;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === 0x13) {
        buf.writeUInt16LE(0x0001, e + 2); // entryFlags bit0 = ragged
        patched = true;
        break;
      }
    }
    expect(patched).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ragged variant unsupported/);
  });

  // ── Fix 2: bound the 0x45/0x46 CSR VALUE reads to the DECLARED region length
  // (+ 4-aligned region start) — Rust parity. `readU32SliceChecked` only bounds
  // against `buf.length`, so a malformed band whose 0x45/0x46 region length is
  // shorter than the computed CSR span ((numEntries+1)*4 + valuesLen*4) would
  // read PAST the declared region into the following region. Rust's
  // `resolve_pattern_band` casts via `bytemuck` (rejects non-4-aligned starts)
  // and the region is gated; we mirror BOTH the span bound and the alignment.

  /** Patch a region-table entry's u64 `length` field (@ +16). Returns true if found. */
  function patchRegionLength(buf: Buffer, regionId: number, newLength: number): boolean {
    const TABLE_OFF = 32;
    const ENTRY = 24;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === regionId) {
        buf.writeBigUInt64LE(BigInt(newLength), e + 16); // length u64 @ +16
        return true;
      }
    }
    return false;
  }

  /** Patch a region-table entry's u64 `offset` field (@ +8). Returns true if found. */
  function patchRegionOffset(buf: Buffer, regionId: number, newOffset: number): boolean {
    const TABLE_OFF = 32;
    const ENTRY = 24;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === regionId) {
        buf.writeBigUInt64LE(BigInt(newOffset), e + 8); // offset u64 @ +8
        return true;
      }
    }
    return false;
  }

  it("(e) a 0x46 PatternTrips region SHORTER than its CSR span throws (region-bound)", () => {
    // The valid fixture's 0x46 holds (numPatterns+1)*4 offset bytes + valuesLen*4
    // value bytes. Shrink the DECLARED length below that computed span: the value
    // reads still fit inside `buf` (the next region's bytes follow), so the old
    // `buf.length`-only check passes — but they read PAST the declared region.
    const buf = Buffer.from(loadBand());
    // numPatterns=3 ⇒ offsets = 4*4 = 16 B; 5 trips ⇒ valuesLen=5 ⇒ 20 B; span=36.
    // Set length to 20 (< 36) so the computed CSR span overflows the region.
    expect(patchRegionLength(buf, 0x46, 20)).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ptb:.*0x46/);
  });

  it("(f) a 0x45 PatternsAtStop region SHORTER than its CSR span throws (region-bound)", () => {
    const buf = Buffer.from(loadBand());
    // numStops=5 ⇒ offsets = 6*4 = 24 B; valuesLen=Σ distinct patterns per stop.
    // Set length to 24 (offsets only, no room for any values) → span overflows.
    expect(patchRegionLength(buf, 0x45, 24)).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ptb:.*0x45/);
  });

  it("(g) a non-4-aligned 0x46 region start throws (bytemuck/cast_u32 parity)", () => {
    const buf = Buffer.from(loadBand());
    // Read the current 4-aligned offset, bump it by 1 → misaligned. The u32 reads
    // would still be in-bounds, but Rust's bytemuck cast rejects this.
    const TABLE_OFF = 32;
    const ENTRY = 24;
    let cur = -1;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === 0x46) {
        cur = Number(buf.readBigUInt64LE(e + 8));
        break;
      }
    }
    expect(cur).toBeGreaterThan(0);
    expect(patchRegionOffset(buf, 0x46, cur + 1)).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ptb: 0x46 .*not 4-aligned/);
  });

  it("(h) a non-4-aligned 0x45 region start throws (bytemuck/cast_u32 parity)", () => {
    const buf = Buffer.from(loadBand());
    const TABLE_OFF = 32;
    const ENTRY = 24;
    let cur = -1;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === 0x45) {
        cur = Number(buf.readBigUInt64LE(e + 8));
        break;
      }
    }
    expect(cur).toBeGreaterThan(0);
    expect(patchRegionOffset(buf, 0x45, cur + 1)).toBe(true);
    expect(() => decodeFrom(buf)).toThrow(/ptb: 0x45 .*not 4-aligned/);
  });

  /** Byte offset of a region body (from its tagged-table `offset u64 @ +8`). */
  function regionBodyOffset(buf: Buffer, regionId: number): number {
    const TABLE_OFF = 32;
    const ENTRY = 24;
    for (let i = 0; ; i++) {
      const e = TABLE_OFF + i * ENTRY;
      if (e + ENTRY > 4096) break;
      const id = buf.readUInt16LE(e);
      if (id === 0) break;
      if (id === regionId) return Number(buf.readBigUInt64LE(e + 8));
    }
    throw new Error(`region 0x${regionId.toString(16)} not found`);
  }

  it("(i) a malformed 0x12 PatternSemantics (declared size != Σ stopCount over non-all-regular patterns) throws — Rust-parity exact-size gate", () => {
    // No committed band fixture carries a non-omitted 0x12 (every band is
    // all-regular), so we MANUFACTURE the malformation: clear pattern 0's
    // all-regular flag (0x10 flags bit0). The fixture has NO 0x12 region, so the
    // expected size becomes pattern 0's stopCount (> 0) while the actual 0x12 size
    // is 0 → the exact-size gate must reject. This is the SAME malformation the
    // Rust `gate_rejects_truncated_pattern_semantics_length` test pins: a 0x12 whose
    // declared length != Σ stopCount over non-all-regular patterns. Both runtimes
    // MUST fail closed identically (else the Rust hot path would read an adjacent
    // region's bytes as boarding flags while TS defaults a missing byte to regular).
    const buf = Buffer.from(loadBand());
    const p10 = regionBodyOffset(buf, 0x10);
    // 0x10 record p: stopsOff u32 @ +0, stopCount u16 @ +4, flags u8 @ +6.
    // Pattern 0's flags live at p10 + 4 (after the count u32 prefix) + 6.
    const flagsByteOff = p10 + 4 + 6;
    const flags = buf.readUInt8(flagsByteOff);
    expect(flags & 0b0000_0001).toBe(0b0000_0001); // pattern 0 IS all-regular
    buf.writeUInt8(flags & ~0b0000_0001, flagsByteOff); // clear bit0 → non-all-regular
    expect(() => decodeFrom(buf)).toThrow(/ptb: 0x12 PatternSemantics length/);
  });
});
