// Three-way smoke over the committed `.ptb` corpus.
//
// Scope (artifact-level gate):
//   wasm == native, over the same committed `.ptb` bytes the engine goldens are
//   pinned against (`packages/frontend/tests/services/__fixtures__`). The native
//   leg is `target/release/pt-core-emit plan <ptb>` (the same binary the per-PR
//   `pt-core-engine-regression` job spawns); the wasm leg is the pt-wasm
//   `PtRouter` running over `pkg-node`.
//
// This is a FAST cross-check of the two bindings against each other at one
// point in time. The authoritative routing contract is the COMMITTED expected
// behaviour: `crates/pt-core/tests/raptor_behavior.rs` pins the native engine
// against `crates/pt-core/tests/golden/`, and `plan_golden.mjs` replays that
// same golden through the production `pt-wasm` binding across all three
// PatternModes.
//
// Footpath-dependent fixtures (footpath.ptb, three-leg.ptb) are covered:
// `PtRouter::set_transfers(buf)` threads a PTFT
// `Transfers` table into the engine call. For tuples that carry a
// `transfersPath`, the smoke reads the bytes and calls
// `router.setTransfers(transfersBuf)` before `router.plan(query)`, matching
// the native leg's `pt-core-emit plan` (which always loads the paired
// `*-transfers.bin` when present).
//
// Schema-overlap normalisation: the wasm and native projections share the
// engine-correctness-relevant fields (`type`, `mode`, `departSecs`,
// `arriveSecs`, `routeId`, `tripId`, `intermediateStops`, `boardStopIdx`,
// `alightStopIdx`, plus per-itin `boardSecs`, `alightSecs`, `transfers`).
// Wasm carries one extra field set the native projection doesn't:
//   wasm-only:   `fromStopId`/`toStopId` (transit-leg variant), `routeShortName`
// The smoke projects BOTH sides into the overlapping subset before
// JSON-equality compare, so a field-shape drift in either projection cannot
// silently mask an engine divergence.
//
// CI-visible summary line (greppable):
//   "pt-wasm-three-way: <N> tuples compared, <M> mismatch"

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixturesDir = join(repoRoot, "packages/frontend/tests/services/__fixtures__");
const tinyPtbPath = join(repoRoot, "packages/shared/src/ptb/__fixtures__/tiny.ptb");
const emitBin = join(repoRoot, "target/release/pt-core-emit");

if (!existsSync(emitBin)) {
  console.error(
    `pt-wasm-three-way: SKIPPED — pt-core-emit not found at ${emitBin}. ` +
      `Build it with: cargo build -p pt-core-emit --release`,
  );
  // Exit 0 (skip) when the native binary is absent. CI builds the binary
  // before invoking this script.
  process.exit(0);
}

const pkg = await import("../pkg-node/pt_wasm.js");

// ── Tuple set ────────────────────────────────────────────────────────────────
//
// Mirrors the TUPLES array in `crates/pt-core/tests/raptor_behavior.rs`,
// including tuples that carry a transfers table. Each tuple carries the same
// query semantics as the Rust behavior test; the assertion is wasm == native
// over the same bytes.
//
// SOURCE OF TRUTH for the query semantics is `raptor_behavior.rs` — if a
// tuple's query changes there, mirror it here.
const PINNED_DATE = "20260505";

/** @typedef {{
 *   name: string,
 *   ptbPath: string,
 *   transfersPath?: string,  // when set, installed via router.setTransfers()
 *                            // on the wasm leg and passed to pt-core-emit
 *                            // on the native leg
 *   skip?: string,            // when set, skip with this reason
 *   query: {
 *     entryStops: Array<{stopId: string, walkSecs: number}>,
 *     exitStops:  Array<{stopId: string, walkSecs: number}>,
 *     departureSecs: number,
 *     date: string,
 *     maxRounds?: number,
 *     mobilityProfile?: "default" | "wheelchair",
 *     excludedModes?: number[],
 *   },
 *   nativeQuery: {
 *     entry: Array<{stopId: string, walkSecs: number}>,
 *     exit:  Array<{stopId: string, walkSecs: number}>,
 *     departureSecs: number,
 *     date: number,
 *     maxRounds: number | null,
 *     wheelchair: boolean,
 *     excludedModes: number[],
 *   },
 * }} Tuple */

/** @type {Tuple[]} */
const TUPLES = [
  {
    name: "default-direct",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 0 }],
      exit: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "wheelchair-trip-skip",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, mobilityProfile: "wheelchair",
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 0 }],
      exit: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: true, excludedModes: [],
    },
  },
  {
    name: "excluded-bus-empty",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, excludedModes: [3],
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 0 }],
      exit: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [3],
    },
  },
  {
    name: "excluded-empty-noop",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, excludedModes: [],
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 0 }],
      exit: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "excluded-unused-noop",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, excludedModes: [0, 1],
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 0 }],
      exit: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [0, 1],
    },
  },
  {
    name: "reverse-canonical-alight",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S3", walkSecs: 0 }],
      exitStops: [{ stopId: "S1", walkSecs: 0 }],
      departureSecs: 30000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "S3", walkSecs: 0 }],
      exit: [{ stopId: "S1", walkSecs: 0 }],
      departureSecs: 30000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "no-path-self",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S1", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 0 }],
      exit: [{ stopId: "S1", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "equal-alight-tie-PQ",
    ptbPath: join(fixturesDir, "equal-alight-tie.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s1", walkSecs: 0 }, { stopId: "s2", walkSecs: 0 }],
      departureSecs: 0, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s1", walkSecs: 0 }, { stopId: "s2", walkSecs: 0 }],
      departureSecs: 0, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "equal-alight-tie-QP-flip",
    ptbPath: join(fixturesDir, "equal-alight-tie.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }, { stopId: "s1", walkSecs: 0 }],
      departureSecs: 0, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }, { stopId: "s1", walkSecs: 0 }],
      departureSecs: 0, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "express-skip-alt-trip",
    ptbPath: join(fixturesDir, "express-skip.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 25200, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 25200, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "terminal-dwell",
    ptbPath: join(fixturesDir, "terminal-dwell.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 25200, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 25200, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "footpath-floor-crossing",
    ptbPath: join(fixturesDir, "footpath.ptb"),
    transfersPath: join(fixturesDir, "footpath-transfers.bin"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "footpath-wheelchair-rescale",
    ptbPath: join(fixturesDir, "footpath.ptb"),
    transfersPath: join(fixturesDir, "footpath-transfers.bin"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, mobilityProfile: "wheelchair",
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: true, excludedModes: [],
    },
  },
  // A query walking speed and minimum transfer cross the wasm boundary as
  // m/s and seconds; the native leg takes the engine's mm/s directly, so these
  // also pin the m/s → mm/s conversion. 200 s raw at 972 mm/s (3.5 km/h) is
  // 257 s; an explicit 1.25 m/s overrides the wheelchair speed; a 300 s
  // minimum floors the 60 s s1→s2 walk.
  {
    name: "footpath-query-walk-speed",
    ptbPath: join(fixturesDir, "footpath.ptb"),
    transfersPath: join(fixturesDir, "footpath-transfers.bin"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, walkSpeedMps: 3.5 / 3.6,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [], walkSpeedMmS: 972,
    },
  },
  {
    name: "footpath-wheelchair-explicit-speed",
    ptbPath: join(fixturesDir, "footpath.ptb"),
    transfersPath: join(fixturesDir, "footpath-transfers.bin"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, mobilityProfile: "wheelchair", walkSpeedMps: 1.25,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: true, excludedModes: [], walkSpeedMmS: 1250,
    },
  },
  {
    name: "footpath-query-min-transfer",
    ptbPath: join(fixturesDir, "footpath.ptb"),
    transfersPath: join(fixturesDir, "footpath-transfers.bin"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, minTransferSecs: 300,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [], minTransferSecs: 300,
    },
  },
  {
    name: "entry-walk-picks-earliest-board",
    ptbPath: tinyPtbPath,
    query: {
      entryStops: [{ stopId: "S1", walkSecs: 600 }, { stopId: "S2", walkSecs: 60 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "S1", walkSecs: 600 }, { stopId: "S2", walkSecs: 60 }],
      exit: [{ stopId: "S3", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "converging-equal-arrival-order",
    ptbPath: join(fixturesDir, "converging-routes.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 0, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 0, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "overnight-after-86400",
    ptbPath: join(fixturesDir, "overnight.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 91700, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 91700, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "express-skip-dwell-altpath",
    ptbPath: join(fixturesDir, "express-skip-dwell.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 28800, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s1", walkSecs: 0 }],
      departureSecs: 28800, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "circular-terminal-alight",
    ptbPath: join(fixturesDir, "circular-loop.ptb"),
    // Exercises circular routes: `output.rs:project_leg` resolves
    // board/alight stop ids from `leg.from_stop` / `leg.to_stop` (matching
    // the native projection), not from the pattern-relative
    // `board_stop_idx`/`alight_stop_idx`.
    query: {
      entryStops: [{ stopId: "s1", walkSecs: 0 }],
      exitStops: [{ stopId: "s0", walkSecs: 0 }],
      departureSecs: 0, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s1", walkSecs: 0 }],
      exit: [{ stopId: "s0", walkSecs: 0 }],
      departureSecs: 0, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "transfer-floor-feasible",
    ptbPath: join(fixturesDir, "transfer-floor.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "transfer-floor-miss",
    ptbPath: join(fixturesDir, "transfer-floor-miss.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "maxrounds-1-empty",
    ptbPath: join(fixturesDir, "maxrounds.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, maxRounds: 1,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: 1, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "maxrounds-2-reaches",
    ptbPath: join(fixturesDir, "maxrounds.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, maxRounds: 2,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: 2, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "maxrounds-0-empty",
    ptbPath: join(fixturesDir, "maxrounds.ptb"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: PINNED_DATE, maxRounds: 0,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s2", walkSecs: 0 }],
      departureSecs: 25000, date: 20260505,
      maxRounds: 0, wheelchair: false, excludedModes: [],
    },
  },
  {
    name: "three-transit-legs-with-footpath",
    ptbPath: join(fixturesDir, "three-leg.ptb"),
    transfersPath: join(fixturesDir, "three-leg-transfers.bin"),
    query: {
      entryStops: [{ stopId: "s0", walkSecs: 0 }],
      exitStops: [{ stopId: "s4", walkSecs: 0 }],
      departureSecs: 0, date: PINNED_DATE,
    },
    nativeQuery: {
      entry: [{ stopId: "s0", walkSecs: 0 }],
      exit: [{ stopId: "s4", walkSecs: 0 }],
      departureSecs: 0, date: 20260505,
      maxRounds: null, wheelchair: false, excludedModes: [],
    },
  },
];

// ── Native helper (subprocess to pt-core-emit) ──────────────────────────────

function nativePlan(tuple) {
  const queryJson = JSON.stringify(tuple.nativeQuery);
  // pt-core-emit signature: `plan <ptb-path> [transfers-path]` — the
  // optional transfers arg mirrors what we feed `router.setTransfers` on
  // the wasm leg, so the engine and its wasm binding see the same footpath table (or none).
  const cliArgs = tuple.transfersPath
    ? ["plan", tuple.ptbPath, tuple.transfersPath]
    : ["plan", tuple.ptbPath];
  const out = execFileSync(emitBin, cliArgs, {
    input: queryJson,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// ── Schema-overlap projection ────────────────────────────────────────────────
//
// Both projections share these fields. Anything outside this subset is
// projection-specific (wasm's routeShortName / fromStopId+toStopId on transit,
// native's mode:"WALK" on walk legs) and not compared — those are projection
// contracts gated by their own smokes (output.rs's unit tests for wasm; the
// engine-regression gate's normalisation for native).

function projectWasmLeg(leg) {
  if (leg.type === "walk") {
    return {
      type: "walk",
      departSecs: leg.departSecs,
      arriveSecs: leg.arriveSecs,
    };
  }
  return {
    type: "transit",
    mode: leg.mode,
    routeId: leg.routeId,
    tripId: leg.tripId,
    departSecs: leg.departSecs,
    arriveSecs: leg.arriveSecs,
    boardStopIdx: leg.boardStopIdx,
    alightStopIdx: leg.alightStopIdx,
    intermediateStops: leg.intermediateStops ?? 0,
  };
}

function projectNativeLeg(leg) {
  if (leg.type === "walk") {
    return {
      type: "walk",
      departSecs: leg.departSecs,
      arriveSecs: leg.arriveSecs,
    };
  }
  return {
    type: "transit",
    mode: leg.mode,
    routeId: leg.routeId,
    tripId: leg.tripId,
    departSecs: leg.departSecs,
    arriveSecs: leg.arriveSecs,
    boardStopIdx: leg.boardStopIdx,
    alightStopIdx: leg.alightStopIdx,
    intermediateStops: leg.intermediateStops ?? 0,
  };
}

function projectItins(itins, projectLeg) {
  return itins.map((it) => ({
    legs: it.legs.map(projectLeg),
    boardSecs: it.boardSecs,
    alightSecs: it.alightSecs,
    transfers: it.transfers,
  }));
}

// ── Compare loop ─────────────────────────────────────────────────────────────

let compared = 0;
let mismatched = 0;
let skipped = 0;

for (const tuple of TUPLES) {
  if (tuple.skip) {
    console.log(`SKIP ${tuple.name}: ${tuple.skip}`);
    skipped++;
    continue;
  }
  if (!existsSync(tuple.ptbPath)) {
    throw new Error(`fixture not found: ${tuple.ptbPath} (tuple "${tuple.name}")`);
  }

  const bytes = readFileSync(tuple.ptbPath);
  const router = new pkg.PtRouter(bytes, "off");
  let wasmRaw;
  try {
    // Install the PTFT transfers table when the tuple carries one.
    // Without this the wasm leg would skip footpath relaxation while
    // the native leg performs it, producing a wasm/native divergence.
    if (tuple.transfersPath) {
      const transfersBytes = readFileSync(tuple.transfersPath);
      router.setTransfers(transfersBytes);
    }
    wasmRaw = router.plan(tuple.query);
  } finally {
    router.free();
  }
  const nativeRaw = nativePlan(tuple);

  const wasmProj = projectItins(wasmRaw, projectWasmLeg);
  const nativeProj = projectItins(nativeRaw, projectNativeLeg);

  compared++;
  const wasmJson = JSON.stringify(wasmProj);
  const nativeJson = JSON.stringify(nativeProj);
  if (wasmJson !== nativeJson) {
    mismatched++;
    console.error(`MISMATCH ${tuple.name}:`);
    console.error(`  wasm:   ${wasmJson}`);
    console.error(`  native: ${nativeJson}`);
  }
}

// CI-greppable summary (mirrors crates/pt-core/tests/raptor_behavior.rs's shape).
console.log(
  `pt-wasm-three-way: ${compared} tuples compared, ${mismatched} mismatch (${skipped} skipped)`,
);

// N > 0 guard (empty tuple set must not silently pass — same posture as
// `crates/pt-core/tests/raptor_behavior.rs`'s golden-corpus tests).
if (compared === 0) {
  console.error("pt-wasm-three-way: N == 0 — no tuples ran (empty set must not pass)");
  process.exit(1);
}
if (mismatched > 0) {
  process.exit(1);
}
