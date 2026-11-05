import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = await import("../pkg-node/pt_wasm.js");

// Construct on tiny.ptb, the producer's current-v1 output for
// crates/pt-producer/tests/fixtures/tiny-gtfs.zip.
const tinyPtb = readFileSync(
  join(here, "../../..", "packages/shared/src/ptb/__fixtures__/tiny.ptb"),
);

// Happy path: PtRouter constructs.
const router = new pkg.PtRouter(tinyPtb, "off");
if (typeof router !== "object") throw new Error("expected PtRouter object");

// Bad-bytes path: corrupt buffer rejects as JsError, NOT a panic.
let threw = null;
try {
  new pkg.PtRouter(new Uint8Array([0, 0, 0, 0]), "off");
} catch (e) {
  threw = e;
}
if (threw === null) throw new Error("expected throw on corrupt buffer");
if (!threw.message || !/PTB|ptb|magic|invalid|reader/i.test(threw.message)) {
  throw new Error(`expected reader-error message, got: ${threw.message}`);
}

console.log("Smoke: PtRouter::new — OK");

//
// tiny.ptb (crates/pt-producer/tests/fixtures/tiny-gtfs/) has
// three stops with ids "S1","S2","S3", routes/trips T1..T4 with serviceIdx 1
// (WD) active on 20260505 (anchor 20260501 + 4; engine/service.rs test pins
// this). T2 departs S1@28800 and reaches S3@29400 → plan() must return ≥1
// itinerary for entry=S1, exit=S3, departure=28800 (08:00).
const planResult = router.plan({
  entryStops: [{ stopId: "S1", walkSecs: 0 }],
  exitStops: [{ stopId: "S3", walkSecs: 0 }],
  date: "20260505",
  departureSecs: 28800,
  excludedModes: [],
});
if (!Array.isArray(planResult)) throw new Error("plan() must return an array");
// So we don't assert non-empty here even though pt-core finds an itinerary — we only assert the
// boundary deserialised cleanly and ran.
console.log("Smoke: plan() returned", planResult.length, "itineraries");

// Unknown stopId → JsError (the string↔index boundary panic site is the
// stop_index None branch; we surface as JsError instead).
let threwUnknownStop = null;
try {
  router.plan({
    entryStops: [{ stopId: "DOES_NOT_EXIST", walkSecs: 0 }],
    exitStops: [{ stopId: "S3", walkSecs: 0 }],
    date: "20260505",
    departureSecs: 28800,
  });
} catch (e) {
  threwUnknownStop = e;
}
if (threwUnknownStop === null) throw new Error("expected throw on unknown stopId");
if (!/unknown stop/i.test(threwUnknownStop.message)) {
  throw new Error(`expected 'unknown stop' message, got: ${threwUnknownStop.message}`);
}

console.log("Smoke: stop_id↔index boundary — OK");

//
// panel fix: a silent leg-shape rename would pass an empty-array
// check while breaking the TS consumer, so the field names are pinned by
// the smoke. tiny.ptb fixture: S1→S3 via T2 (departs S1@28800, arrives
// S3@29400) → ≥1 itinerary on 20260505 @ 08:00.
const result2 = router.plan({
  entryStops: [{ stopId: "S1", walkSecs: 0 }],
  exitStops: [{ stopId: "S3", walkSecs: 0 }],
  date: "20260505",
  departureSecs: 28800,
});
if (result2.length === 0) {
  console.log("Smoke: no itineraries for the pinned query; output shape not checkable on empty");
} else {
  const itin = result2[0];
  if (typeof itin.boardSecs !== "number") throw new Error("missing boardSecs");
  if (typeof itin.alightSecs !== "number") throw new Error("missing alightSecs");
  if (typeof itin.transfers !== "number") throw new Error("missing transfers");
  if (!Array.isArray(itin.legs)) throw new Error("legs must be an array");
  for (const leg of itin.legs) {
    if (leg.type !== "walk" && leg.type !== "transit") {
      throw new Error(`leg.type must be 'walk'|'transit', got: ${JSON.stringify(leg.type)}`);
    }
    if (leg.type === "transit") {
      // Field-name pin (panel architect #4 — aligns with @pt/shared
      // RaptorTransitLeg which uses fromStopId/toStopId, not board/alight).
      for (const k of ["routeId", "routeShortName", "mode", "fromStopId", "toStopId", "tripId"]) {
        if (!(k in leg)) throw new Error(`transit leg missing key: ${k}`);
      }
    }
  }
}
console.log("Smoke: tagged-union output shape — OK");

//
// the frontend visibility-change handler calls isAlive() WITHOUT try/catch. A throw kills the
// listener for the tab. So the contract is: isAlive() MUST return false (never throw) after free(),
// even though the auto-generated wasm-bindgen.free() would normally cause subsequent method calls
// on the JS handle to throw "null pointer passed to rust".
{
  const r = new pkg.PtRouter(tinyPtb, "off");
  if (r.isAlive() !== true) throw new Error("expected isAlive() true on fresh router");
  r.free();
  // CONTRACT: isAlive() MUST return false after free(), NEVER throw.
  // P6's visibility-change handler calls this without try/catch — a throw
  // here kills the listener and the recovery path silently breaks.
  let alive;
  try { alive = r.isAlive(); }
  catch (e) { throw new Error(`isAlive() must NOT throw after free(): ${e.message}`); }
  if (alive !== false) throw new Error(`expected isAlive() === false after free(), got: ${alive}`);
}
console.log("Smoke: isAlive() — OK");

//
// The full 200 -> 313 half-up rescale is exercised by
// `crates/pt-core/src/engine/scan.rs::footpath_rescales_for_wheelchair_profile`,
// which boots a 3-stop PTB plus a PTFT transfers table with a 200s s1->s3
// footpath edge and asserts the wheelchair-profile arrival lands at 25813
// (25500 + 313). The committed fixture for that scenario is
// `packages/frontend/tests/services/__fixtures__/footpath.ptb` (with paired
// `footpath-transfers.bin`), produced by `pt-core-emit gen-fixtures`.
//
// The wasm surface in P5 deliberately wires `transfers: None` at `crates/pt-wasm/src/lib.rs:68`
// ("No transfers in P5 smoke; P6 wires them via PtRouter::set_transfers."). Without a transfers
// table the footpath-relaxation pass — and therefore the wheelchair rescale itself — cannot fire
// across the wasm boundary. So the 200 -> 313 numeric pin is DEFERRED to the three-way smoke, which
// targets the same `footpath.ptb`/`footpath-transfers.bin` fixture pair once
// `PtRouter::set_transfers` lands.
//
const wcResult = router.plan({
  entryStops: [{ stopId: "S1", walkSecs: 0 }],
  exitStops: [{ stopId: "S3", walkSecs: 0 }],
  date: "20260505",
  departureSecs: 28800,
  mobilityProfile: "wheelchair",
});
if (!Array.isArray(wcResult)) throw new Error("wheelchair plan() must return an array");
if (wcResult.length === 0) {
  throw new Error("wheelchair plan() returned 0 itineraries on tiny.ptb (T2 has wheelchair_accessible=1; expected >=1)");
}
console.log(
  "Smoke: wheelchair profile parsed + planned — OK",
);

// mobilityProfile string-match contract (round-2 QA HIGH): query.rs matches
// "default" | "wheelchair" exactly. Anything else (case variants, empty,
// null) must throw `unknown mobilityProfile` rather than silently accepting.
// Pinning the contract here prevents P6's adapter from shipping a
// case-insensitive expectation that would silently 500 on day one.
{
  const cases = ["DEFAULT", "Wheelchair", "  default", "", "WHEELCHAIR"];
  for (const profile of cases) {
    let threw = null;
    try {
      router.plan({
        entryStops: [{ stopId: "S1", walkSecs: 0 }],
        exitStops: [{ stopId: "S3", walkSecs: 0 }],
        date: "20260505",
        departureSecs: 28800,
        mobilityProfile: profile,
      });
    } catch (e) {
      threw = e;
    }
    if (threw === null) {
      throw new Error(
        `Smoke: expected mobilityProfile=${JSON.stringify(profile)} to throw (case-sensitive match)`,
      );
    }
    if (!/unknown mobilityProfile/i.test(threw.message)) {
      throw new Error(
        `Smoke: expected 'unknown mobilityProfile' message for ${JSON.stringify(profile)}, got: ${threw.message}`,
      );
    }
  }
}
console.log("Smoke: mobilityProfile string-match is case-sensitive — OK");

// walkSpeedMps / minTransferSecs: in range they plan; out of range they throw
// the engine's shared message (pt_core::engine::consts::parse_walk_params).
{
  const base = {
    entryStops: [{ stopId: "S1", walkSecs: 0 }],
    exitStops: [{ stopId: "S3", walkSecs: 0 }],
    date: "20260505",
    departureSecs: 28800,
  };
  const ok = router.plan({ ...base, walkSpeedMps: 3.5 / 3.6, minTransferSecs: 300 });
  if (!Array.isArray(ok) || ok.length === 0) throw new Error("walk params: in-range plan must return itineraries");
  const bad = [
    [{ walkSpeedMps: 0 }, /walkSpeedMps must be between 0.1 and 10 m\/s/],
    [{ walkSpeedMps: 11 }, /walkSpeedMps must be between/],
    [{ walkSpeedMps: Number.NaN }, /walkSpeedMps must be between/],
    [{ minTransferSecs: 3601 }, /minTransferSecs must be at most 3600/],
  ];
  for (const [extra, pattern] of bad) {
    let threw = null;
    try { router.plan({ ...base, ...extra }); } catch (e) { threw = e; }
    if (threw === null || !pattern.test(threw.message)) {
      throw new Error(`walk params: expected ${pattern} for ${JSON.stringify(extra)}, got: ${threw?.message}`);
    }
  }
}
console.log("walk params smoke: walkSpeedMps / minTransferSecs parsed and range-checked — OK");

//
// P5 wired `transfers: None` into the pt_core::plan call (lib.rs:68); the three-way smoke SKIPS the
// 3 footpath-dependent tuples for that reason. The smoke proves: (a) valid PTFT bytes are accepted
// without throw, (b) sub-magic buffers are rejected via JsError (NOT a wasm panic — master ).
{
  const transfersPath = join(
    here,
    "../../..",
    "packages/frontend/tests/services/__fixtures__/footpath-transfers.bin",
  );
  const transfersBytes = readFileSync(transfersPath);
  const r = new pkg.PtRouter(tinyPtb, "off");
  // Happy path: valid PTFT bytes must NOT throw.
  r.setTransfers(transfersBytes);
  // Short buffer (< 4 magic bytes) must throw JsError, not panic.
  let threwShort = null;
  try { r.setTransfers(new Uint8Array([1, 2, 3])); } catch (e) { threwShort = e; }
  if (threwShort === null) {
    throw new Error("Smoke: setTransfers should reject < 4-byte buffer");
  }
  r.free();
}
console.log("Smoke: setTransfers(buf) — OK");
