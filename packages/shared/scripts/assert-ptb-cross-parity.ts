import { readFileSync } from "node:fs";
import { loadPtb, lookupStopIndexRegion, bytesPerService } from "../src/ptb/loader.js";

// Cross-language projection parity: build the SAME canonical JSON string that
// pt-core's `project()` (crates/pt-core/src/projection.rs) emits from tiny.ptb,
// and assert it byte-equals the committed golden
// `crates/pt-core/tests/tiny.projection.json`. The Rust integration test asserts
// `project == golden` too, so both languages anchor to the one golden file.
//
// The string is built BY HAND with the same fixed field order and fixed key
// order the Rust side uses — NOT JSON.stringify of an object (whose key order is
// not guaranteed to match Rust's literal order).

// Pinned projection dates — mirrors pt-core projection::PINNED_DATES.
// day 0 (byte0), day 13 (byte1 bit5), day 80 (byte10 — high bitmask byte).
const PINNED_DATES = [20260501, 20260514, 20260720] as const;

/** JSON-escape a string (matches the subset Rust `esc()` handles). */
function esc(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out;
}
const jstr = (s: string): string => `"${esc(s)}"`;
const u32arr = (vals: ArrayLike<number>): string => `[${Array.from(vals).join(",")}]`;

// Howard Hinnant days_from_civil — MUST match reader.rs `days_from_civil`.
function daysFromCivil(yyyymmdd: number): number {
  const y0 = Math.floor(yyyymmdd / 10000);
  const m = Math.floor(yyyymmdd / 100) % 100;
  const d = yyyymmdd % 100;
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function project(bundlePath: string): string {
  const b = loadPtb(readFileSync(bundlePath));

  // Service-bitmask window length is the RUNTIME `windowDays` decoded from the
  // optional `0x01 WindowMeta` region (default 90 when absent). Mirrors `pt_core::Reader::window_days` / `service_active_on`'s
  // window guard; the old hardcoded `SERVICE_WINDOW_DAYS = 90` would have
  // silently mis-bounded any feed with a derived window > 90 (Step A.7).
  const serviceActiveOn = (serviceIdx: number, date: number): boolean => {
    const day = daysFromCivil(date) - daysFromCivil(b.feedStartDate);
    if (day < 0 || day >= b.windowDays) return false;
    // Per-service stride is the RUNTIME `ceil(windowDays/8)`, NOT the fixed
    // 12-byte default — a windowDays=400 bundle slices 50 B/service.
    const base = serviceIdx * bytesPerService(b.windowDays);
    const byte = b.serviceBitmasks[base + Math.floor(day / 8)];
    if (byte === undefined) return false;
    return ((byte >> (day % 8)) & 1) === 1;
  };

  let out = "{";
  out += `"version":${b.version},`;
  out += `"feedStartDate":${b.feedStartDate},`;
  // Must match pt-core projection.rs field order (right after feedStartDate).
  out += `"cityTzOffsetSeconds":${b.cityTzOffsetSeconds},`;
  out += `"numServices":${b.numServices},`;
  out += `"numStops":${b.stops.length},`;
  out += `"numRoutes":${b.routes.length},`;
  out += `"numTrips":${b.trips.length},`;
  out += `"numStopTimes":${b.stopTimes.length},`;

  // Canonical integer latE7/lonE7 columns. Mirrors pt-core projection.rs.
  const stops = b.stops.map(
    (s) =>
      `{"stopId":${jstr(s.stopId)},"stopName":${jstr(s.stopName)},"latE7":${s.latE7},"lonE7":${s.lonE7},"wheelchairBoarding":${s.wheelchairBoarding}}`,
  );
  out += `"stops":[${stops.join(",")}],`;

  const routes = b.routes.map(
    (r) =>
      `{"routeId":${jstr(r.routeId)},"agencyId":${jstr(r.agencyId)},"shortName":${jstr(r.routeShortName)},"longName":${jstr(r.routeLongName)},"routeType":${r.routeType},"routeColor":${jstr(r.routeColor)},"routeTextColor":${jstr(r.routeTextColor)}}`,
  );
  out += `"routes":[${routes.join(",")}],`;

  const trips = b.trips.map(
    (t) =>
      `{"tripId":${jstr(t.tripId)},"headsign":${jstr(t.headsign)},"routeIdx":${t.routeIdx},"serviceIdx":${t.serviceIdx},"wheelchairAccessible":${t.wheelchairAccessible},"directionId":${t.directionId},"shapeId":${jstr(t.shapeId)}}`,
  );
  out += `"trips":[${trips.join(",")}],`;

  const stopTimes = b.stopTimes.map(
    (st) =>
      `{"depSecs":${st.depSecs},"arrDiff":${st.arrDiff},"stopIdx":${st.stopIdx},"stopSeq":${st.stopSeq}}`,
  );
  out += `"stopTimes":[${stopTimes.join(",")}],`;

  out += `"tripStarts":${u32arr(b.tripStarts)},`;
  out += `"routeTripsOffsets":${u32arr(b.routeTripsOffsets)},`;
  out += `"routeTripsValues":${u32arr(b.routeTripsValues)},`;
  out += `"stopRoutesOffsets":${u32arr(b.stopRoutesOffsets)},`;
  out += `"stopRoutesValues":${u32arr(b.stopRoutesValues)},`;

  out += '"serviceActive":{';
  out += PINNED_DATES.map((date) => {
    const bits: string[] = [];
    for (let s = 0; s < b.numServices; s++) bits.push(serviceActiveOn(s, date) ? "true" : "false");
    return `"${date}":[${bits.join(",")}]`;
  }).join(",");
  out += "}";

  // stopParents — sorted (childIdx, parentIdx) pairs; matches pt-core
  // projection.rs (emitted last, after serviceActive).
  const parents = b.stopParents.map((p) => `{"childIdx":${p.childIdx},"parentIdx":${p.parentIdx}}`);
  out += `,"stopParents":[${parents.join(",")}]`;

  out += "}";
  return out;
}

/**
 * Cross-language StopIndex parity: the persisted StopIndex region
 * (`0x44`) MUST resolve every id identically to an eager string `Map` built
 * from the decoded stops — the SAME oracle the Rust gate uses (NOT a same-hash
 * rebuild, which would hide a symmetric error). Catches a host↔engine divergence in
 * `fnv1a32` or the string tiebreak that the projection check can't see (the
 * StopIndex region is absent from the projection).
 */
function assertStopIndexParity(name: string, fixturePath: string): void {
  const buf = readFileSync(fixturePath);
  const b = loadPtb(buf);
  if (!b.stopIndexRegion) {
    console.error(`stopindex-parity FAIL (${name}): expected a persisted StopIndex region`);
    process.exit(1);
  }
  const ref = new Map<string, number>();
  b.stops.forEach((s, i) => ref.set(s.stopId, i)); // last-wins, like the eager Map
  for (const s of b.stops) {
    const got = lookupStopIndexRegion(buf, b.stopIndexRegion, b.stringPool, s.stopId);
    const want = ref.get(s.stopId);
    if (got !== want) {
      console.error(`stopindex-parity FAIL (${name}): id "${s.stopId}" → ${got}, expected ${want}`);
      process.exit(1);
    }
  }
  if (lookupStopIndexRegion(buf, b.stopIndexRegion, b.stringPool, "__definitely_absent__") !== undefined) {
    console.error(`stopindex-parity FAIL (${name}): absent id must resolve to undefined`);
    process.exit(1);
  }
  console.log(`ptb persisted-StopIndex parity OK (${name}, ${b.stops.length} ids)`);
}

/**
 * Runtime `windowDays` cross-parity (Step A.7): assert the TS loader decodes the
 * expected window length AND that the per-service stride of the materialized
 * service-bitmask view equals `ceil(windowDays/8)`. The loader enforces the
 * exact-size pool gate (`0x15` length == 4 + count * stride), so a successful
 * `loadPtb` here is itself proof the pool was sliced at the decoded stride — we
 * additionally cross-check the arithmetic.
 *
 * BOTH paths are covered across the call sites: the absent-default (90 → stride
 * 12; an omit-at-default bundle) AND the present 0x01 path (400 → stride
 * 50; the producer-emitted window400 fixture). The Rust side asserts the SAME
 * committed bytes decode to `window_days() == 400` / `bytes_per_service == 50`
 * via `pt_core::Reader` in the producer's `tests/window_emit.rs` integration check.
 */
function assertWindowDays(name: string, fixturePath: string, expectedDays: number): void {
  const buf = readFileSync(fixturePath);
  const b = loadPtb(buf);
  const expectedStride = bytesPerService(expectedDays);
  if (b.windowDays !== expectedDays) {
    console.error(
      `windowdays-parity FAIL (${name}): windowDays=${b.windowDays}, expected ${expectedDays}`,
    );
    process.exit(1);
  }
  if (bytesPerService(b.windowDays) !== expectedStride) {
    console.error(
      `windowdays-parity FAIL (${name}): ceil(windowDays/8)=${bytesPerService(b.windowDays)}, expected ${expectedStride}`,
    );
    process.exit(1);
  }
  // The materialized view is exactly numServices * stride — i.e. the decoded
  // stride is the one the bytes were written at, not just an arithmetic identity.
  const actualStride =
    b.numServices > 0 ? b.serviceBitmasks.length / b.numServices : expectedStride;
  if (actualStride !== expectedStride) {
    console.error(
      `windowdays-parity FAIL (${name}): region stride ${actualStride} (len ${b.serviceBitmasks.length} / ${b.numServices} services) != ${expectedStride}`,
    );
    process.exit(1);
  }
  console.log(
    `ptb windowDays cross-parity OK (${name}, windowDays=${expectedDays}, stride=${expectedStride})`,
  );
}

/**
 * Independent current ServiceBitfieldPool decode. Scans the tagged
 * region table DIRECTLY off the raw bytes — NOT via `loadPtb`'s region resolution
 * or `bundle.serviceBitmasks` — to read the `0x15 ServiceBitfieldPool` (count u32
 * + count×S distinct bitfields) and `0x16 ServiceToBitfield` (numServices × u32
 * pool indices) regions, then materializes the flat `numServices × S` view a
 * second, fully-independent way and asserts it equals `bundle.serviceBitmasks`
 * for EVERY service. A materialization bug shared by the Rust seam AND the TS flat
 * view (which would otherwise agree-and-pass) is caught here, because this decoder
 * shares no code with either. Also returns `{count, stride, numServices}` so the
 * caller can pin the exact-size stride invariant.
 *
 * The tagged region table mirrors loader.ts: 24-byte entries at offset 32,
 * regionId u16 @+0 (0 = terminator), offset u64 @+8, length u64 @+16. Region ids
 * 0x15 = ServiceBitfieldPool, 0x16 = ServiceToBitfield.
 */
const SERVICE_BITFIELD_POOL_REGION_ID = 0x15;
const SERVICE_TO_BITFIELD_REGION_ID = 0x16;
const REGION_TABLE_OFFSET = 32;
const REGION_ENTRY_BYTES = 24;

function assertIndependentPoolDecode(name: string, fixturePath: string): void {
  const buf = readFileSync(fixturePath);
  const b = loadPtb(buf);
  if (b.version !== 1) {
    console.error(`service-pool-decode FAIL (${name}): expected version 1, got ${b.version}`);
    process.exit(1);
  }
  const stride = bytesPerService(b.windowDays);
  const numServices = b.numServices;

  // ── Independent raw scan of the tagged region table (no loadPtb regions). ──
  let poolOff = -1;
  let poolLen = -1;
  let idxOff = -1;
  let idxLen = -1;
  for (let i = 0; ; i++) {
    const e = REGION_TABLE_OFFSET + i * REGION_ENTRY_BYTES;
    if (e + REGION_ENTRY_BYTES > buf.length) break;
    const regionId = buf.readUInt16LE(e);
    if (regionId === 0) break;
    const off = Number(buf.readBigUInt64LE(e + 8));
    const len = Number(buf.readBigUInt64LE(e + 16));
    if (regionId === SERVICE_BITFIELD_POOL_REGION_ID) {
      poolOff = off;
      poolLen = len;
    } else if (regionId === SERVICE_TO_BITFIELD_REGION_ID) {
      idxOff = off;
      idxLen = len;
    }
  }
  if (poolOff < 0 || idxOff < 0) {
    console.error(
      `service-pool-decode FAIL (${name}): missing 0x15 (off=${poolOff}) / 0x16 (off=${idxOff}) region`,
    );
    process.exit(1);
  }
  const count = buf.readUInt32LE(poolOff);

  // ── Exact-size stride invariants: the pool body is `4 + count*S`, the
  //    index is `numServices*4`. A byte-vs-element stride confusion or a dropped
  //    `count` prefix surfaces here.
  if (poolLen !== 4 + count * stride) {
    console.error(
      `service-pool-decode FAIL (${name}): 0x15 length ${poolLen} != 4 + count*${stride} ` +
        `(count=${count}, windowDays=${b.windowDays}, need ${4 + count * stride})`,
    );
    process.exit(1);
  }
  if (idxLen !== numServices * 4) {
    console.error(
      `service-pool-decode FAIL (${name}): 0x16 length ${idxLen} != numServices*4 ` +
        `(numServices=${numServices}, need ${numServices * 4})`,
    );
    process.exit(1);
  }

  // ── Materialize the flat view INDEPENDENTLY (own pool walk) and compare to the
  //    bundle's materialized serviceBitmasks for every service byte. ──
  const poolPayload = poolOff + 4;
  let folded = false; // did at least two services share a pool slot (genuine fold)?
  const seen = new Set<number>();
  for (let s = 0; s < numServices; s++) {
    const poolIdx = buf.readUInt32LE(idxOff + s * 4);
    if (poolIdx >= count) {
      console.error(
        `service-pool-decode FAIL (${name}): ServiceToBitfield[${s}]=${poolIdx} >= count=${count}`,
      );
      process.exit(1);
    }
    if (seen.has(poolIdx)) folded = true;
    seen.add(poolIdx);
    const src = poolPayload + poolIdx * stride;
    for (let bIdx = 0; bIdx < stride; bIdx++) {
      const independent = buf[src + bIdx]!;
      const viaBundle = b.serviceBitmasks[s * stride + bIdx]!;
      if (independent !== viaBundle) {
        console.error(
          `service-pool-decode FAIL (${name}): service ${s} byte ${bIdx}: independent pool[${poolIdx}]` +
            `=${independent} != bundle.serviceBitmasks=${viaBundle}`,
        );
        process.exit(1);
      }
    }
  }
  // The fixture is chosen so the pool GENUINELY folds (count < numServices). If it
  // ever stops folding the cross-parity loses its `0x16 → 0x15`-traversal teeth.
  if (count >= numServices || !folded) {
    console.error(
      `service-pool-decode FAIL (${name}): pool must genuinely fold (count=${count} < numServices=${numServices} ` +
        `and >=2 services sharing a slot); folded=${folded}`,
    );
    process.exit(1);
  }
  console.log(
    `ptb v1 ServiceBitfieldPool independent-decode parity OK (${name}, count=${count}, numServices=${numServices}, stride=${stride}, genuine fold)`,
  );
}

const tinyGolden = process.argv[2];
const canaryGolden = process.argv[3];
const servicePoolGolden = process.argv[4];
const tinyV1Golden = process.argv[5];
const overnightI32Golden = process.argv[6];
if (
  !tinyGolden ||
  !canaryGolden ||
  !servicePoolGolden ||
  !tinyV1Golden ||
  !overnightI32Golden
) {
  console.error(
    "usage: assert-ptb-cross-parity.ts <tiny.projection.json> <canary.projection.json> <tiny-service-pool.projection.json> <tiny-v1.projection.json> <overnight-i32.projection.json>",
  );
  process.exit(2);
}

// Each golden pairs with the fixture that generated it. The canary carries
// multi-byte UTF-8 ids/names, a negative arrDiff (i16 high byte), and a
// stopSeq > 255 (u16 high byte) — high-byte paths the ASCII tiny feed misses.
// tiny-service-pool is the ServiceBitfieldPool cross-parity fixture. Its
// pool GENUINELY folds (count=2 < numServices=3 — services 0 and 2 share a slot),
// so the materialized flat view + the independent pool decode below exercise
// the `0x16 → 0x15` traversal, not a degenerate flat read.
const cases: Array<{
  name: string;
  golden: string;
  fixture: string;
  stopIndex?: boolean;
  servicePool?: boolean;
}> = [
  { name: "tiny", golden: tinyGolden, fixture: "../src/ptb/__fixtures__/tiny.ptb" },
  { name: "canary", golden: canaryGolden, fixture: "../src/ptb/__fixtures__/canary.ptb" },
  { name: "tiny-service-pool", golden: servicePoolGolden, fixture: "../src/ptb/__fixtures__/tiny-service-pool.ptb", stopIndex: true, servicePool: true },
  // tiny-v1 is the current PTB v1 cross-parity fixture: a SoA pattern-band
  // bundle whose flat 0xF4/0xF5/0xF6/0xFA carry is STRIPPED, so loadPtb re-materializes
  // the flat {stopTimes, tripStarts, boarding} + the route→trips CSR from the band via
  // bandToFlatStopTimes (the carry-less path). Rust project() reconstructs the SAME flat
  // rows (projection.rs is_carry_less_band branch), so the TS and Rust projections anchor
  // to the one golden. It carries a persisted StopIndex (0x44 — stopIndex-parity-checked).
  // It is not a fold case (1 service, pool count 1), so no independent pool-decode leg.
  { name: "tiny-v1", golden: tinyV1Golden, fixture: "../src/ptb/__fixtures__/tiny-v1.ptb", stopIndex: true },
  // overnight-i32 is the carry-less current PTB v1 fixture forcing the
  // region-level `0x13 TripTimes` i32-delta variant
  // (entryFlags bit1): one trip
  // whose s0→s2 dep-delta 55800s (> i16::MAX ~9.1h) pushes the whole `0x13` region
  // onto the 4-byte i32 layout, plus a nonzero dwell on the long-span rows. project()
  // re-materializes the flat stopTimes from the band on BOTH sides (Rust's
  // is_carry_less_band branch, TS loadPtb's bandToFlatStopTimes), so a Rust↔TS i32
  // decode divergence (wrong width / stride / sign) surfaces as a depSecs/arrDiff
  // mismatch against the one golden. It lives in the frontend engine corpus fixtures
  // directory and is also the engine-regression i32 tuple's fixture, so the path
  // reaches across packages. It has one service, so no independent pool-decode leg.
  // It carries no persisted StopIndex region (band cohort) → no stopIndex leg.
  {
    name: "overnight-i32",
    golden: overnightI32Golden,
    fixture: "../../frontend/tests/services/__fixtures__/overnight-i32.ptb",
  },
];

for (const c of cases) {
  const fixturePath = new URL(c.fixture, import.meta.url);
  const actual = project(fixturePath.pathname);
  const golden = readFileSync(c.golden, "utf8").trimEnd();
  if (actual !== golden) {
    // First differing character + surrounding context for a clear error.
    const n = Math.min(actual.length, golden.length);
    let i = 0;
    while (i < n && actual[i] === golden[i]) i++;
    const ctx = (s: string): string => s.slice(Math.max(0, i - 40), i + 40);
    console.error(`cross-parity FAIL (${c.name}): TS projection != golden`);
    console.error(`first diff at char ${i}`);
    console.error(`  golden: ...${ctx(golden)}...`);
    console.error(`  ts:     ...${ctx(actual)}...`);
    process.exit(1);
  }
  console.log(`ptb cross-language projection parity OK (${c.name})`);
  if (c.stopIndex) {
    assertStopIndexParity(c.name, fixturePath.pathname);
  }
  if (c.servicePool) {
    // Independently decode 0x15/0x16 RAW and assert the materialized flat view
    // matches bundle.serviceBitmasks for every service (no shared code with the
    // loader's materialization), plus the exact-size stride invariants.
    const b = loadPtb(readFileSync(fixturePath.pathname));
    if (b.version !== 1) {
      console.error(`cross-parity FAIL (${c.name}): expected version 1, got ${b.version}`);
      process.exit(1);
    }
    assertIndependentPoolDecode(c.name, fixturePath.pathname);
  }
}

// ── Runtime windowDays cross-parity (Step A.7) ──────────────────────────────
// Cover BOTH the absent-default 90 path and the present-0x01 400 path:
//   - tiny-service-pool: omit-at-default (no 0x01 region) → windowDays 90, stride 12.
//   - window400: PRODUCER-EMITTED at --anchor-date 20260619 over a feed whose
//     calendar end_date=20270710 derives windowDays = 386 + 14 = 400 exactly
//     (WindowClampEvent::None) → stride 50. A hand-built fixture would only
//     exercise the reader; this one drives the real producer derive.
assertWindowDays("tiny-service-pool (absent-default)", new URL("../src/ptb/__fixtures__/tiny-service-pool.ptb", import.meta.url).pathname, 90);
assertWindowDays("window400 (producer-emitted)", new URL("../src/ptb/__fixtures__/window400.ptb", import.meta.url).pathname, 400);

// ── 0x17 Frequencies cross-language decoder parity ───────────────
// Loads the committed `frequencies-parity.ptb`, decodes its `0x17 Frequencies`
// region via the TS loader, and asserts the 3 known rows. The Rust side performs
// the SAME decode in `gen_fixtures::tests::frequencies_parity_fixture_round_trip`.
// Together they prove the Rust and TypeScript wire decoders agree on the same bytes.
assertFrequenciesParity(new URL("../src/ptb/__fixtures__/frequencies-parity.ptb", import.meta.url).pathname);

function assertFrequenciesParity(fixturePath: string): void {
  const buf = readFileSync(fixturePath);
  const b = loadPtb(buf);
  if (!b.frequencies) {
    console.error("frequencies-parity FAIL: frequencies undefined (0x17 region absent)");
    process.exit(1);
  }
  const rows = b.frequencies;
  if (rows.length !== 3) {
    console.error(`frequencies-parity FAIL: expected 3 rows, got ${rows.length}`);
    process.exit(1);
  }
  // Row 0: tripIdx=0, startSecs=21600, endSecs=86400, headwaySecs=600, exactTimes=0
  if (rows[0].tripIdx !== 0 || rows[0].startSecs !== 21600 || rows[0].endSecs !== 86400 || rows[0].headwaySecs !== 600 || rows[0].exactTimes !== 0) {
    console.error(`frequencies-parity FAIL: row 0 mismatch: ${JSON.stringify(rows[0])}`);
    process.exit(1);
  }
  // Row 1: tripIdx=0, startSecs=86400, endSecs=108000, headwaySecs=1800, exactTimes=1
  if (rows[1].tripIdx !== 0 || rows[1].startSecs !== 86400 || rows[1].endSecs !== 108000 || rows[1].headwaySecs !== 1800 || rows[1].exactTimes !== 1) {
    console.error(`frequencies-parity FAIL: row 1 mismatch: ${JSON.stringify(rows[1])}`);
    process.exit(1);
  }
  // Row 2: tripIdx=1, startSecs=36000, endSecs=72000, headwaySecs=900, exactTimes=0
  if (rows[2].tripIdx !== 1 || rows[2].startSecs !== 36000 || rows[2].endSecs !== 72000 || rows[2].headwaySecs !== 900 || rows[2].exactTimes !== 0) {
    console.error(`frequencies-parity FAIL: row 2 mismatch: ${JSON.stringify(rows[2])}`);
    process.exit(1);
  }
  console.log("ptb frequencies cross-language decoder parity OK (3 rows: 2 for trip 0, 1 for trip 1)");
}
