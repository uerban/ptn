// Engine-owned wasm regression runner: replay the committed RAPTOR golden
// through the production `pt-wasm` binding.
//
// Reads `crates/pt-core/tests/golden/raptor-plan.golden.tsv` — the same file
// `crates/pt-core/tests/raptor_behavior.rs` pins the native engine against —
// and, for every (tuple x PatternMode) record, constructs a `PtRouter` over the
// record's `.ptb` bytes in the record's mode, installs the paired PTFT
// `transfers.bin` when the record has one, rebuilds the query from the record's
// query JSON, and compares the binding's output against the record's pinned
// itineraries.
//
// What this adds over the native suite: the `PtRouter` constructor's mode
// parsing, `set_transfers`, the `WasmQuery` deserialisation (camelCase field
// names, `date` as a STRING, `excludedModes` as route_type integers,
// `mobilityProfile` incl. "bicycle"), and the wasm projection in
// `src/output.rs`. A break anywhere on that path shows up here as a named
// record mismatch even though the underlying engine is unchanged.
//
// Schema-overlap projection: the wasm projection carries fields the native one
// does not (`routeShortName`, `routeColor`, `patternStopIds`, walk-leg
// `walkSecs`) and omits the native walk leg's `mode: "WALK"`. Both sides are
// projected into the shared subset before comparison, so a field-shape drift
// on either side cannot mask a routing divergence. The shared subset still
// covers every engine-correctness field: leg type/order, mode, from/to stop
// ids, depart/arrive seconds, route id, trip id, board/alight positions,
// intermediate stop count, the `approximate` frequency marker, and the
// per-itinerary board/alight seconds and transfer count.
//
// Distinct from `three_way.mjs`, which compares wasm against a freshly spawned
// `pt-core-emit` over a hand-mirrored subset of the tuples in `off` mode only.
// That is wasm-vs-native at one point in time; this one pins wasm to a
// COMMITTED expected result across all three PatternModes and the full corpus.
//
// CI-greppable summary, one line per mode:
//   "pt-wasm-plan-golden: <N> records compared (<mode>), <M> mismatch"

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const goldenPath = join(repoRoot, "crates/pt-core/tests/golden/raptor-plan.golden.tsv");
const pkgPath = join(here, "../pkg-node/pt_wasm.js");

if (!existsSync(pkgPath)) {
  console.error(
    `pt-wasm-plan-golden: pkg-node not found at ${pkgPath}. ` +
      `Build it with: cd crates/pt-wasm && wasm-pack build --release --target nodejs --out-dir pkg-node`,
  );
  process.exit(1);
}
if (!existsSync(goldenPath)) {
  console.error(
    `pt-wasm-plan-golden: golden not found at ${goldenPath}. ` +
      `Regenerate with: PT_UPDATE_GOLDEN=1 cargo test -p pt-core --test raptor_behavior`,
  );
  process.exit(1);
}

const pkg = await import(pkgPath);

// ── Golden records ───────────────────────────────────────────────────────────

/** @typedef {{
 *   name: string,
 *   mode: string,
 *   ptbPath: string,
 *   transfersPath: string | null,
 *   query: {
 *     entryStops: Array<{stopId: string, walkSecs: number}>,
 *     exitStops: Array<{stopId: string, walkSecs: number}>,
 *     departureSecs: number,
 *     date: number,
 *     maxRounds: number | null,
 *     mobilityProfile: string,
 *     excludedRouteTypes: number[],
 *   },
 *   itineraries: unknown[],
 * }} GoldenRecord */

/** @type {GoldenRecord[]} */
const RECORDS = readFileSync(goldenPath, "utf8")
  .split("\n")
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line, i) => {
    const f = line.split("\t");
    if (f.length !== 6) {
      throw new Error(
        `pt-wasm-plan-golden: malformed golden record on data line ${i + 1} ` +
          `(expected 6 tab-separated fields, got ${f.length})`,
      );
    }
    return {
      name: f[0],
      mode: f[1],
      ptbPath: join(repoRoot, f[2]),
      transfersPath: f[3] ? join(repoRoot, f[3]) : null,
      query: JSON.parse(f[4]),
      itineraries: JSON.parse(f[5]),
    };
  });

if (RECORDS.length === 0) {
  console.error("pt-wasm-plan-golden: golden carries 0 records — an empty set must not pass");
  process.exit(1);
}

// ── Query rebuild ────────────────────────────────────────────────────────────
//
// The golden stores the engine-neutral query; this maps it into the WasmQuery
// shape the binding deserialises: `date` as a string, `excludedModes` as
// route_type integers, and both optional fields OMITTED when absent (mirroring
// what the production adapter sends).

function wasmQueryOf(record) {
  const q = {
    entryStops: record.query.entryStops,
    exitStops: record.query.exitStops,
    date: String(record.query.date),
    departureSecs: record.query.departureSecs,
    mobilityProfile: record.query.mobilityProfile,
  };
  if (record.query.maxRounds !== null) {
    q.maxRounds = record.query.maxRounds;
  }
  if (record.query.excludedRouteTypes.length > 0) {
    q.excludedModes = record.query.excludedRouteTypes;
  }
  if (record.query.excludedRouteIds?.length) q.excludedRouteIds = record.query.excludedRouteIds;
  return q;
}

// ── Schema-overlap projection ────────────────────────────────────────────────

function projectLeg(leg) {
  if (leg.type === "walk") {
    return {
      type: "walk",
      fromStopId: leg.fromStopId,
      toStopId: leg.toStopId,
      departSecs: leg.departSecs,
      arriveSecs: leg.arriveSecs,
    };
  }
  return {
    type: "transit",
    mode: leg.mode,
    fromStopId: leg.fromStopId,
    toStopId: leg.toStopId,
    departSecs: leg.departSecs,
    arriveSecs: leg.arriveSecs,
    routeId: leg.routeId,
    tripId: leg.tripId,
    boardStopIdx: leg.boardStopIdx,
    alightStopIdx: leg.alightStopIdx,
    intermediateStops: leg.intermediateStops ?? 0,
    approximate: leg.approximate === true,
  };
}

function projectItins(itins) {
  return itins.map((it) => ({
    legs: it.legs.map(projectLeg),
    boardSecs: it.boardSecs,
    alightSecs: it.alightSecs,
    transfers: it.transfers,
  }));
}

// ── Replay ───────────────────────────────────────────────────────────────────

const compared = new Map();
const mismatched = new Map();
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

// Cache the `.ptb` / transfers bytes per path: the corpus reuses each fixture
// across modes and tuples, and re-reading them ~260 times is pure I/O waste.
const bytesCache = new Map();
const readCached = (p) => {
  let b = bytesCache.get(p);
  if (!b) {
    if (!existsSync(p)) throw new Error(`pt-wasm-plan-golden: fixture not found: ${p}`);
    b = readFileSync(p);
    bytesCache.set(p, b);
  }
  return b;
};

for (const record of RECORDS) {
  const router = new pkg.PtRouter(readCached(record.ptbPath), record.mode);
  let actual;
  try {
    if (record.transfersPath) {
      router.setTransfers(readCached(record.transfersPath));
    }
    actual = router.plan(wasmQueryOf(record));
  } finally {
    router.free();
  }

  bump(compared, record.mode);
  const got = JSON.stringify(projectItins(actual));
  const want = JSON.stringify(projectItins(record.itineraries));
  if (got !== want) {
    bump(mismatched, record.mode);
    console.error(`MISMATCH ${record.name} [${record.mode}]:`);
    console.error(`  golden: ${want}`);
    console.error(`  wasm:   ${got}`);
  }
}

let failed = false;
for (const mode of ["off", "unbounded", "covering-merge"]) {
  const n = compared.get(mode) ?? 0;
  const m = mismatched.get(mode) ?? 0;
  console.log(`pt-wasm-plan-golden: ${n} records compared (${mode}), ${m} mismatch`);
  if (n === 0) {
    console.error(`pt-wasm-plan-golden: 0 records in ${mode} mode — an empty set must not pass`);
    failed = true;
  }
  if (m > 0) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
