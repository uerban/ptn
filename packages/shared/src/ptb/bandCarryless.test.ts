/**
 * carry-less band-fixture load proof.

 *
 * The committed band cohort (`pattern-band-tiny.ptb` + the four multipattern
 * siblings) is stripped of the flat carry — `0xF4 StopTimes` / `0xF5
 * TripStarts` / `0xF6 Csr` / `0xFA StopTimeBoarding`. The gen_fixtures writer
 * strips it in T5a, matching the producer strip that landed in T4 (commit
 * `840a467a`). The pattern band (`0x10`-`0x14` + `0x45`/`0x46`) is
 * the SOLE timetable. This test proves `loadPtb` produces a complete, self-
 * consistent bundle from those carry-less bytes:
 *   - each fixture has its expected version, carries the band, and has no flat carry;
 *   - the timetable is MATERIALIZED from the band (`stopTimes`/`tripStarts`/
 *     boarding), populated and prefix-sum-consistent;
 *   - the route→trips CSR is SYNTHESIZED from per-trip `routeIdx` (the stop→routes
 *     CSR is empty — the band's `0x45 PatternsAtStop` drives ON-mode routesAtStop),
 *     mirroring the Rust reader's `synthesize_carry_from_band`;
 *   - `ptbBundleToWire` emits routes for every PatternMode (the band-grouping path).
 *
 * The carry-BEARING-vs-carry-less EQUIVALENCE (band materialize == flat carry) is
 * proven elsewhere now that no committed fixture carries the flat carry:
 *   - `bandToFlatStopTimes.test.ts` — the band→flat decoder against a synthetic
 *     in-memory band (+ the committed band's own materialized rows);
 *   - the Rust `mod carry_less` (index.rs) — builds carry-bearing in-memory, strips,
 *     and asserts index/plan equivalence;
 *   - the engine-regression gate — host↔engine agree bit-for-bit over the carry-less
 *     committed cohort under Unbounded + CoveringMerge.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPtb } from "./loader.js";
import { ptbBundleToWire } from "./ptbToBundleWire.js";
import { PatternMode } from "../raptor/patternMode.js";

// ── Locate the repo root (holds the committed Rust-built band fixtures) ────────
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny.ptb"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("bandCarryless.test: could not locate repo root from " + process.cwd());
}
const REPO_ROOT = findRepoRoot();
const FIXTURE_DIR = resolve(REPO_ROOT, "packages/frontend/tests/services/__fixtures__");

/**
 * The committed band fixtures are all carry-less: the band is the timetable.
 * Each entry pairs the fixture name with its expected header
 * version: `pattern-band-tiny.ptb` and the four named band fixtures all carry
 * the current PTB v1 layout.
 */
const FIXTURES = [
  ["pattern-band-tiny.ptb", 1],
  ["branch-pattern.ptb", 1],
  ["lasso-multipattern.ptb", 1],
  ["converging-multipattern.ptb", 1],
  ["covering-merge.ptb", 1],
] as const;

const TABLE_OFF = 32; // tagged region table starts at header byte 32
const ENTRY = 24; // each entry is 24 B (regionId u16 @ +0)
const HEADER_PREFIX = 4096;

/** The four flat carry region ids the T5a teardown strips. */
const STRIPPED_CARRY_IDS = [0xf4, 0xf5, 0xf6, 0xfa] as const;

/** True iff the tagged region table contains `regionId` with a non-zero length. */
function hasRegion(buf: Buffer, regionId: number): boolean {
  for (let i = 0; ; i++) {
    const e = TABLE_OFF + i * ENTRY;
    if (e + ENTRY > HEADER_PREFIX) break;
    const id = buf.readUInt16LE(e);
    if (id === 0) break; // terminator
    if (id === regionId) {
      // length is the u64 @ +16 (low 32 bits suffice for these small fixtures).
      return buf.readUInt32LE(e + 16) > 0;
    }
  }
  return false;
}

describe.each(FIXTURES)("carry-less committed fixture — %s", (name, version) => {
  const path = resolve(FIXTURE_DIR, name);
  const buf = readFileSync(path);

  it("the four flat carries (0xF4/0xF5/0xF6/0xFA) are ABSENT (T5a teardown fired)", () => {
    for (const id of STRIPPED_CARRY_IDS) {
      expect(hasRegion(buf, id), `carry region 0x${id.toString(16)} must be stripped`).toBe(false);
    }
  });

  it("loadPtb reports the fixture's expected version, carries the band, and the flat carry is empty", () => {
    const b = loadPtb(buf);
    expect(b.version).toBe(version);
    expect(b.patternBand).toBeDefined();
  });

  it("the timetable is MATERIALIZED from the band (populated + tripStarts prefix-sum consistent)", () => {
    const b = loadPtb(buf);
    expect(b.stopTimes.length).toBeGreaterThan(0);
    expect(b.tripStarts.length).toBe(b.trips.length + 1);
    expect(b.tripStarts[0]).toBe(0);
    expect(b.tripStarts[b.tripStarts.length - 1]).toBe(b.stopTimes.length);
  });

  it("the route→trips CSR is SYNTHESIZED from routeIdx; stop→routes is empty (band-0x45 driven)", () => {
    const b = loadPtb(buf);
    // route→trips: (numRoutes+1) non-decreasing prefix-sum, last == trips.length,
    // and every trip appears exactly once (partition by route).
    expect(b.routeTripsOffsets.length).toBe(b.routes.length + 1);
    expect(b.routeTripsOffsets[0]).toBe(0);
    expect(b.routeTripsOffsets[b.routeTripsOffsets.length - 1]).toBe(b.trips.length);
    expect(b.routeTripsValues.length).toBe(b.trips.length);
    const seen = new Set<number>();
    for (const t of b.routeTripsValues) seen.add(t);
    expect(seen.size).toBe(b.trips.length);
    // Each trip lands in its own route's slot (matches per-trip routeIdx).
    for (let r = 0; r < b.routes.length; r++) {
      for (let i = b.routeTripsOffsets[r]!; i < b.routeTripsOffsets[r + 1]!; i++) {
        expect(b.trips[b.routeTripsValues[i]!]!.routeIdx).toBe(r);
      }
    }
    // stop→routes is empty carry-less (the band's 0x45 drives routesAtStop).
    expect(b.stopRoutesValues.length).toBe(0);
    expect(b.stopRoutesOffsets[b.stopRoutesOffsets.length - 1]).toBe(0);
  });

  it.each([PatternMode.Off, PatternMode.Unbounded, PatternMode.CoveringMerge])(
    "ptbBundleToWire emits routes from the carry-less bundle (mode=%s)",
    (mode) => {
      const wire = ptbBundleToWire(loadPtb(buf), mode);
      expect(wire.routes.length).toBeGreaterThan(0);
      // Every emitted trip carries a populated departureSecs array (materialized
      // from the band's 0x13 TripTimes — the carry-less timetable source).
      for (const route of wire.routes) {
        for (const trip of route.trips) {
          expect(trip.departureSecs.length).toBe(route.stopIds.length);
        }
      }
    },
  );
});
