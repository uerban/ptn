import { readFileSync } from "node:fs";
import { loadPtb } from "../src/ptb/loader.js";

// Decoded-content check of a PTB v1 bundle through the TypeScript loader.
//
//   assert-ptb-parity.ts [--tiny-gtfs] <bundle.ptb>
//
// Every input must decode as a current v1 SoA bundle with in-range stop
// coordinates and parents. With `--tiny-gtfs`, the input must be the Rust
// producer's output for crates/pt-producer/tests/fixtures/tiny-gtfs.zip
// (anchor 20260501, Europe/Vilnius), and its decoded ids, names, flags, and
// parents are pinned against that feed. This catches a Rust-writer vs
// TypeScript-reader drift in string pooling or record decoding.
//
// Expected values for tiny-gtfs:
//   feedStartDate:        20260501
//   cityTzOffsetSeconds:  10800  (Europe/Vilnius EEST at feedStartDate=20260501)
//   stops:                3  (S1, S2, S3 — UTF-8-bytewise sorted; names: Stop One/Two/Three)
//   routes:               2  (R1, R2; long names: Route One, Route Two)
//   trips:                4  (T1, T2, T3, T4)
//   wheelchair:           stop S2 wheelchairBoarding=1; trip T1 wheelchairAccessible=2
//   stopParents:          [(childIdx 1 -> parent 0), (childIdx 2 -> parent 0)]
const args = process.argv.slice(2);
const tinyGtfs = args.includes("--tiny-gtfs");
const bundlePath = args.find((a) => a !== "--tiny-gtfs");
if (!bundlePath) {
  console.error("usage: assert-ptb-parity.ts [--tiny-gtfs] <bundle.ptb>");
  process.exit(2);
}
const b = loadPtb(readFileSync(bundlePath));
function fail(msg: string): never { console.error(`parity FAIL: ${msg}`); process.exit(1); }

if (b.version !== 1) fail(`version ${b.version} != 1`);
if (!b.stopsSoaRegion) fail("SoA: StopsSoA 0x40 region absent");
if (!b.routesSoaRegion) fail("SoA: RoutesSoA 0x41 region absent");
if (b.stops.length < 1) fail("SoA: no stops");
if (b.routes.length < 1) fail("SoA: no routes");
for (const s of b.stops) {
  if (!Number.isInteger(s.latE7) || !Number.isInteger(s.lonE7))
    fail(`SoA: stop ${s.stopId} latE7/lonE7 not integer (${s.latE7}/${s.lonE7})`);
  if (s.latE7! < -900_000_000 || s.latE7! > 900_000_000) fail(`SoA: stop ${s.stopId} latE7 ${s.latE7} out of WGS84`);
  if (s.lonE7! < -1_800_000_000 || s.lonE7! > 1_800_000_000) fail(`SoA: stop ${s.stopId} lonE7 ${s.lonE7} out of WGS84`);
  if (!Number.isFinite(s.stopLat) || !Number.isFinite(s.stopLon)) fail(`SoA: stop ${s.stopId} stopLat/stopLon not finite`);
}
// dense-derived stopParents: in-range, non-self, strictly sorted by child
if (!Array.isArray(b.stopParents)) fail("SoA: missing stopParents array");
for (let i = 0; i < b.stopParents.length; i++) {
  const { childIdx, parentIdx } = b.stopParents[i]!;
  if (childIdx < 0 || childIdx >= b.stops.length) fail(`stopParents[${i}].childIdx ${childIdx} out of range`);
  if (parentIdx < 0 || parentIdx >= b.stops.length) fail(`stopParents[${i}].parentIdx ${parentIdx} out of range`);
  if (childIdx === parentIdx) fail(`stopParents[${i}] self-parent ${childIdx}`);
  if (i > 0 && childIdx <= b.stopParents[i - 1]!.childIdx) fail(`stopParents not strictly sorted by childIdx at ${i}`);
}

if (tinyGtfs) {
  if (b.feedStartDate !== 20260501) fail(`feedStartDate ${b.feedStartDate} != 20260501`);
  const routes = b.routes.map((r) => r.routeId).sort();
  if (JSON.stringify(routes) !== JSON.stringify(["R1", "R2"])) fail(`routes ${JSON.stringify(routes)} != ["R1","R2"]`);
  if (b.stops.length !== 3) fail(`stops ${b.stops.length} != 3`);
  if (b.trips.length !== 4) fail(`trips ${b.trips.length} != 4`);

  // String content: catch Rust UTF-8/pool-offset encoding regressions, not
  // just count correctness. Values from tiny-gtfs routes.txt and stops.txt.
  const stopIds = b.stops.map((s) => s.stopId).sort();
  if (JSON.stringify(stopIds) !== JSON.stringify(["S1", "S2", "S3"]))
    fail(`stop ids ${JSON.stringify(stopIds)} != ["S1","S2","S3"]`);
  const s1 = b.stops.find((s) => s.stopId === "S1");
  if (!s1 || s1.stopName !== "Stop One")
    fail(`stop S1 name "${s1?.stopName}" != "Stop One"`);
  const routeLongNames = b.routes.map((r) => r.routeLongName).sort();
  if (JSON.stringify(routeLongNames) !== JSON.stringify(["Route One", "Route Two"]))
    fail(`route long names ${JSON.stringify(routeLongNames)} != ["Route One","Route Two"]`);

  // wheelchair_boarding / wheelchair_accessible
  const s2 = b.stops.find((s) => s.stopId === "S2");
  if (!s2 || s2.wheelchairBoarding !== 1)
    fail(`stop S2 wheelchairBoarding ${s2?.wheelchairBoarding} != 1`);
  if (!b.stops.some((s) => s.wheelchairBoarding === 0)) fail("no stop with wheelchairBoarding=0 found");
  const t1 = b.trips.find((t) => t.tripId === "T1");
  if (!t1 || t1.wheelchairAccessible !== 2)
    fail(`trip T1 wheelchairAccessible ${t1?.wheelchairAccessible} != 2`);

  // route_color / route_text_color: R1 → FF0000/FFFFFF, R2 → 00FF00
  const r1 = b.routes.find((r) => r.routeId === "R1");
  if (!r1 || r1.routeColor !== "FF0000")
    fail(`route R1 routeColor "${r1?.routeColor}" != "FF0000"`);
  if (!r1 || r1.routeTextColor !== "FFFFFF")
    fail(`route R1 routeTextColor "${r1?.routeTextColor}" != "FFFFFF"`);
  const r2 = b.routes.find((r) => r.routeId === "R2");
  if (!r2 || r2.routeColor !== "00FF00")
    fail(`route R2 routeColor "${r2?.routeColor}" != "00FF00"`);

  // direction_id + shape_id: T2 direction_id=1, T1 shape_id=shp_A
  const t2 = b.trips.find((t) => t.tripId === "T2");
  if (!t2 || t2.directionId !== 1)
    fail(`trip T2 directionId ${t2?.directionId} != 1`);
  if (!t1 || t1.shapeId !== "shp_A")
    fail(`trip T1 shapeId "${t1?.shapeId}" != "shp_A"`);

  // calendar.txt has WD + SA → 2 services
  if (b.numServices !== 2)
    fail(`numServices ${b.numServices} != 2`);

  // city tz offset + parent_station
  if (b.cityTzOffsetSeconds !== 10800) fail(`cityTzOffsetSeconds ${b.cityTzOffsetSeconds} != 10800 (EEST)`);
  if (JSON.stringify(b.stopParents) !== JSON.stringify([{ childIdx: 1, parentIdx: 0 }, { childIdx: 2, parentIdx: 0 }]))
    fail(`stopParents ${JSON.stringify(b.stopParents)} != [{1,0},{2,0}]`);
}

console.log("ptb parity OK");
