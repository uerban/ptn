/**
 * `.ptb → RaptorBundleWire` adapter — the TS side of the P2 engine-regression gate.

 *
 * Decodes a `.ptb` via `loadPtb` and assembles a `PtbBundleWire` object
 * (defined below) that is structurally assignable to `RaptorBundleWire` — keep
 * the two in sync; a new REQUIRED field on `RaptorBundleWire` will only surface
 * at the `rawFromBundle(...)` call site, not here. It is consumed by
 * `raptorIndex.ts::rawFromBundle`/`hydrate`, so the TS
 * `runRaptor` engine and the Rust `pt-core::plan` engine see the SAME network
 * over the SAME bytes. The Rust side reads the `.ptb` directly; this adapter is
 * the only seam that must reproduce Rust `Index::build`'s structural decisions
 * exactly, or the engine-regression diff is meaningless.
 *
 * The structural decisions reproduced here (mirroring `loadFromPtb.ts:408-458`
 * and the Rust `crates/pt-core/src/engine/index.rs`):
 *   - canonical `stopIds` = the LONGEST trip's stop sequence in `stopSeq` order,
 *     tie-broken by first-in-route_trips (strict `>`), repeats preserved;
 *   - per-trip `departureSecs[]` aligned to canonical positions via a
 *     stopIdx→positions-LIST map consumed in stopSeq order (a per-trip cursor
 *     assigns each row to the next unused occurrence of its stop, so lasso/loop
 *     routes that revisit a stop keep BOTH legs' departures — see
 *     https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes),
 *     `-1` where the trip does not serve that position (skipped OR sentinel-dep
 *     row; a sentinel-dep row still consumes its occurrence slot);
 *   - per-trip `dwellSecs?[]` from `arrDiff` (dwell = -arrDiff when negative),
 *     omitted entirely when every dwell is zero.
 *
 * `directionPatterns` are opt-in via `includeDirectionPatterns`. The
 * engine-regression gate leaves them off because `hydrate` would fold sibling stops
 * that the Rust CSR lacks; the production browser catalog turns them on so line
 * previews retain return-only/branched stops after retiring Node raptor-data.
 *
 * Service ids are synthesised as the raw service ORDINAL string ("0","1",...),
 * matching `serviceIdFor(i)` in `loadFromPtb.ts` and the `pt-core-emit
 * service-active` output. The calendar `days[]`/range is reconstructed from the
 * runtime `windowDays`-day bitmask window (the loaded PTB's `windowDays`, default
 * 90 when the `0x01` WindowMeta region is absent) so `resolveActiveServices(date)`
 * agrees with the Rust `service_active_on(date)` on the harness's pinned date
 * (the gate asserts that equality as a precondition).
 */

import {
  bytesPerService,
  type PtbBundle,
  type PtbPatternBand,
} from "./loader.js";
import type { TransportMode } from "../types/transit.js";
import { PatternMode, patternsEnabled } from "../raptor/patternMode.js";
import {
  coveringMergeFold,
  groupTripsByPattern,
  type PatternGroup,
} from "../raptor/patternSignature.js";

const MISSING_DEP_SENTINEL = 0xffffffff;

/**
 * route_type → TransportMode. Range-based, total (GTFS basic 0–12 + Google
 * Extended Route Types 100–1799; unknown/out-of-range → OTHER). Single TS SoT,
 * pinned equal to pt-core by the committed golden table
 * (`__fixtures__/route-type-mode.golden.txt`). Kept in @pt/shared so backend
 * imports it (no duplicate switch).
 */
export function routeTypeToMode(routeType: number): TransportMode {
  if (routeType === 0) return "TRAM";
  if (routeType === 1) return "METRO";
  if (routeType === 2) return "RAIL";
  if (routeType === 3) return "BUS";
  if (routeType === 4) return "FERRY";
  if (routeType === 5) return "CABLE_TRAM";
  if (routeType === 6) return "AERIAL";
  if (routeType === 7) return "FUNICULAR";
  if (routeType === 11) return "TROLLEYBUS";
  if (routeType === 12) return "METRO";
  if (routeType >= 100 && routeType <= 199) return "RAIL";
  if (routeType >= 200 && routeType <= 299) return "BUS";
  if (routeType >= 400 && routeType <= 499) return "METRO";
  if (routeType >= 700 && routeType <= 799) return "BUS";
  if (routeType >= 800 && routeType <= 899) return "TROLLEYBUS";
  if (routeType >= 900 && routeType <= 999) return "TRAM";
  if (routeType >= 1000 && routeType <= 1099) return "FERRY";
  if (routeType >= 1200 && routeType <= 1299) return "FERRY";
  if (routeType >= 1300 && routeType <= 1399) return "AERIAL";
  if (routeType >= 1400 && routeType <= 1499) return "FUNICULAR";
  if (routeType >= 1100 && routeType <= 1199) return "OTHER"; // air — no transit analog
  if (routeType >= 1500 && routeType <= 1599) return "OTHER"; // taxi
  if (routeType >= 1700 && routeType <= 1799) return "OTHER"; // misc
  return "OTHER";
}

/** Mirror of the wire shape `rawFromBundle`/`hydrate` consume. */
export interface PtbBundleWire {
  version: number;
  meta: { generatedAt: string };
  routes: Array<{
    id: string;
    shortName: string;
    mode: TransportMode;
    color?: string;
    textColor?: string;
    stopIds: string[];
    trips: Array<{
      tripId: string;
      serviceId: string;
      headsign: string;
      /** GTFS direction_id decoded from the existing PTB trip record. */
      directionId?: 0 | 1;
      /** PTB trip ordinal, used to join frequencies.txt rows after route-local trip sorting. */
      ptbTripIdx: number;
      departureSecs: number[];
      dwellSecs?: number[];
      /**
 * Sparse per-stop GTFS `pickup_type` / `drop_off_type`, aligned to canonical positions
 * (parallel to `dwellSecs`). `pickup_type == 1` ⇒ alight-only (no boarding); `drop_off_type ==
 * 1` ⇒ board-only (no alighting). Omitted when every value is default 0 (the norm, and the
 * region-absent case). Sourced from the decoded boarding byte (`continuous_*` are deliberately
 * NOT forwarded — YAGNI). GTFS reference:
 * https://gtfs.org/documentation/schedule/reference/#stop_timestxt
 */
      pickupTypes?: number[];
      dropOffTypes?: number[];
      wheelchairAccessible?: number;
      bikesAllowed?: number;
      shapeId?: string;
    }>;
    directionPatterns?: Array<{
      key: string;
      headsign: string;
      stopIds: string[];
    }>;
  }>;
  calendar: Array<{
    serviceId: string;
    days: boolean[];
    startDate: string;
    endDate: string;
    exceptions: Record<string, number>;
  }>;
  stops: Array<{
    id: string;
    name: string;
    lat: number;
    lon: number;
    wheelchairBoarding?: number;
  }>;
  /**
   * GTFS `transfers.txt` rules, idx→string-resolved from `loadPtb().transfers`.
   * Empty when the feed carries no transfers. The engine index (`hydrate`)
   * keeps only the UNSCOPED rules (no from/to route AND no from/to trip) and
   * applies `transfer_type` 3 (not possible) / 2 (min_transfer_time) in the
   * scan; scoped fields are carried here for the forward-compat S2/S3 slices.
   * `undefined` = the source feed omitted that optional field.
   * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
   */
  transfers?: WireTransfer[];
  frequencies?: WireFrequency[];
}

/** One GTFS `transfers.txt` rule with string ids (idx→string resolved). */
export interface WireTransfer {
  /** Absent only on a PTB v2 linked row (transfer_type 4/5) keyed by trips alone. */
  fromStopId?: string;
  toStopId?: string;
  transferType: number;
  minTransferSecs?: number;
  fromRouteId?: string;
  toRouteId?: string;
  fromTripId?: string;
  toTripId?: string;
}

export interface PtbBundleWireOptions {
  /** Emit display-only direction/headsign stop sequences for the browser catalog. */
  includeDirectionPatterns?: boolean;
}

export interface WireFrequency {
  tripIdx: number;
  startSecs: number;
  endSecs: number;
  headwaySecs: number;
  exactTimes: 0 | 1;
}

function wireExactTimes(value: number, tripIdx: number): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new Error(`ptbToBundleWire: frequency exact_times ${value} for tripIdx ${tripIdx} is not 0 or 1`);
}

interface TripRows {
  tripIdx: number;
  // `pickupType`/`dropOffType` are derived from the decoded `0xFA` byte at the
  // GLOBAL stop_time row and attach to the decoded row so they ride the stopSeq
  // sort (else folded/lasso members desync). Default 0 when boarding is absent.
  rows: {
    stopIdx: number;
    stopSeq: number;
    depSecs: number;
    arrDiff: number;
    pickupType: number;
    dropOffType: number;
  }[];
}

/** Service-ordinal string id, matching `serviceIdFor` / pt-core-emit. */
function serviceIdFor(ordinal: number): string {
  return String(ordinal);
}

/** Add `n` days to a YYYYMMDD integer, returning a YYYYMMDD integer. */
function addDays(yyyymmdd: number, n: number): number {
  const y = Math.floor(yyyymmdd / 10000);
  const m = Math.floor((yyyymmdd % 10000) / 100);
  const d = yyyymmdd % 100;
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
}

function ymdToString(yyyymmdd: number): string {
  return String(yyyymmdd).padStart(8, "0");
}

function bitmaskActive(bitmask: Uint8Array, day: number): boolean {
  const byte = day >> 3;
  const bit = day & 7;
  return byte < bitmask.length ? ((bitmask[byte]! >> bit) & 1) === 1 : false;
}

/**
 * Reconstruct a service's Monday-first `days[]` from its `windowDays`-day
 * bitmask: for each weekday, take the first window-day with that weekday and
 * read its bit. The window anchor (`feedStartDate`) drives the weekday
 * alignment. This makes `resolveActiveServices` (calendar-based) and the Rust
 * bitmask lookup agree on any date the bitmask follows a clean weekly pattern;
 * the harness pins a date inside the window and asserts the resulting
 * active-service SET matches the Rust `service-active` output (the precondition
 * that gates this synthesis). `windowDays` is the runtime window from the loaded
 * PTB (default 90 when the `0x01` WindowMeta region is absent).
 */
function deriveDays(bitmask: Uint8Array, feedStartDate: number, windowDays: number): boolean[] {
  const days: (boolean | null)[] = [null, null, null, null, null, null, null];
  for (let n = 0; n < windowDays; n++) {
    const date = addDays(feedStartDate, n);
    const y = Math.floor(date / 10000);
    const m = Math.floor((date % 10000) / 100);
    const d = date % 100;
    const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
    const monFirst = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon..6=Sun
    if (days[monFirst] === null) days[monFirst] = bitmaskActive(bitmask, n);
  }
  return days.map((b) => b === true);
}

/**
 * Invert the band's `0x46 PatternTrips` CSR into a `trip_idx → pattern_idx` map.
 * `decodePatternBand` cross-checks `0x14 TripMeta.pattern_idx ↔ 0x46 PatternTrips`
 * set-identity at decode (loader.ts), so the inverted `0x46` membership equals the
 * `0x14` backref Rust `build_from_band` reads — we source the grouping from the
 * decoded CSR (no raw-buffer dependency) instead of re-reading the `0x14` bytes.
 *
 * FAIL-CLOSED: the map is pre-filled with the sentinel `0xffffffff` (claimed by NO
 * pattern), NOT zero — a zero-init would make a trip absent from EVERY `0x46` slice
 * silently default to pattern 0. The real load path can't hit this (the loader's
 * `0x14 ↔ 0x46` set-identity cross-check guarantees every trip is claimed exactly
 * once), but a hand-constructed band can; {@link groupFromBand} throws on the
 * sentinel so the behaviour is symmetric with Rust `build_from_band`, which errors
 * (`Corrupt("0x14 trip pattern_idx out of range")`) on an unclaimable pattern_idx.
 */
function tripPatternFromBand(band: PtbPatternBand, numTrips: number): Uint32Array {
  const tripPattern = new Uint32Array(numTrips).fill(0xffffffff);
  for (let p = 0; p < band.numPatterns; p++) {
    const lo = band.patternTripsOffsets[p]!;
    const hi = band.patternTripsOffsets[p + 1]!;
    for (let j = lo; j < hi; j++) tripPattern[band.patternTripsValues[j]!] = p;
  }
  return tripPattern;
}

/**
 * Band-sourced per-route grouping (Design A, a TS port of Rust `build_from_band`,
 * `crates/pt-core/src/engine/index.rs`). The grouping comes from the pattern
 * band's `pattern_idx` — NOT from re-deriving a stop-signature — while the
 * departures come from the flat stop-time rows (`loadPtb` re-materializes them
 * from the band on a carry-less bundle) via the UNCHANGED {@link emitWireRoute}
 * cursor.
 *
 * GROUPS BY `pattern_idx`, NOT BY RE-SIGNATURE (faithful to Rust). Per GTFS route
 * we map each of the route's `tripIdxs` (in `route_trips` LOCAL order) to its band
 * `pattern_idx` (from `0x14`/`0x46`), then group by that `pattern_idx` in
 * first-appearance order over `route_trips` — mirroring `build_from_band`'s
 * per-route `group_pidx.position(...)` loop exactly. Each group's `stopIdxs` is
 * the pattern's `0x11 PatternStops` slice (the band canonical, repeats preserved
 * — Pin 2 / lasso) and `offsets` are all 0 (native members).
 *
 * Grouping by `pattern_idx` rather than re-signing the `0x11` slice matters
 * because the locked-layout spec
 * allows TWO DISTINCT patterns over the SAME stop sequence (e.g. a semantics-annotated
 * pattern vs a plain one): a `stopIdxs.join(",")` re-signature would WRONGLY
 * collapse them into one group, diverging from Rust. For the current stops-only
 * cohort the two coincide (distinct `pattern_idx` ⟹ distinct `0x11` signature),
 * so this is byte-equivalent today — but it is the faithful port for the format's
 * distinct-same-stop allowance.
 *
 * For `CoveringMerge` we run the SAME normative {@link coveringMergeFold} over the
 * `pattern_idx`-grouped Unbounded base (identical input ⇒ byte-identical fold,
 * single-sourcing the fold with the flat path and the Rust
 * `covering_merge_fold` mirror, `index.rs`). The fold sets the folded members'
 * composed offsets; Unbounded returns the base unfolded.
 *
 * NOTE ON ROUTE ORDER: Rust drains its Unbounded `IndexRoute`s in GLOBAL
 * `pattern_idx` (`0x10`) order across all routes, whereas this builds per-route in
 * `route_trips` first-appearance order. The two coincide because the band's `0x10`
 * enumeration is ROUTE-MAJOR BY CONSTRUCTION: the band is emitted from
 * `Index::build(.., Unbounded)`, which builds patterns per GTFS route in route
 * order, so the global `0x10`/`pattern_idx` order equals this builder's per-route
 * `route_trips` first-appearance order route-by-route. The multi-route converging
 * fixture (`converging-multipattern`: R0's two patterns then R1's one) exercises
 * exactly this — both builders enumerate R0's patterns before R1's. `routesAtStop`
 * additionally keys by stop-id value-arrays, so order-of-appearance there is
 * value-equal — but the global-drain (route-major) ordering is the canonical one.
 *
 * GTFS lasso/loop canonical (repeated stop): the band's `0x11` keeps the repeat,
 * and the per-trip cursor in `emitWireRoute` aligns both legs — see
 * https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
 */
function groupFromBand(
  band: PtbPatternBand,
  tripPattern: Uint32Array,
  tripIdxs: number[],
  mode: PatternMode,
): PatternGroup[] {
  const stopIdxsOfPattern = (p: number): number[] => {
    const rec = band.patterns[p];
    if (!rec) throw new Error(`ptbToBundleWire: band pattern idx ${p} out of range`);
    return Array.from(
      band.patternStops.subarray(rec.stopsOff, rec.stopsOff + rec.stopCount),
    );
  };

  // Group this route's trips by their band `pattern_idx`, preserving `route_trips`
  // (first-appearance) order — the TS mirror of Rust `build_from_band`'s
  // `group_pidx.iter().position(...)` per-route loop. `groupPidx[gi]` is the band
  // pattern_idx of the gi-th group; `base[gi]` is its PatternGroup.
  const groupPidx: number[] = [];
  const base: PatternGroup[] = [];
  for (const t of tripIdxs) {
    const p = tripPattern[t]!;
    // Fail-closed (see `tripPatternFromBand`): the sentinel means trip `t` was
    // claimed by NO `0x46` pattern slice. Rust `build_from_band` errors here
    // (`Corrupt("0x14 trip pattern_idx out of range")`); throw rather than fold it
    // into pattern 0 (the silent zero-init bug this guards).
    if (p === 0xffffffff) {
      throw new Error(`ptb: trip ${t} claimed by no pattern (absent from every 0x46 PatternTrips slice)`);
    }
    if (p >= band.numPatterns) {
      throw new Error(`ptb: trip ${t} band pattern_idx ${p} out of range`);
    }
    const gi = groupPidx.indexOf(p);
    if (gi >= 0) {
      base[gi]!.tripIdxs.push(t);
      base[gi]!.offsets.push(0); // native member
    } else {
      groupPidx.push(p);
      base.push({ stopIdxs: stopIdxsOfPattern(p), tripIdxs: [t], offsets: [0] });
    }
  }

  // Unbounded returns the native base; CoveringMerge folds it via the shared,
  // CI-pinned normative `coveringMergeFold` (identical input ⇒ byte-identical to
  // the flat path's fold and the Rust `covering_merge_fold`).
  return mode === PatternMode.CoveringMerge ? coveringMergeFold(base) : base;
}

/**
 * Emit ONE wire-route record for the given `canonical` stop-index sequence and
 * the member `tripIdxs`. This is the verbatim per-route body from the original
 * loop, parameterised on `canonical`/`tripIdxs` so it can be called once (Off
 * path) or once per pattern group (Unbounded path) without touching the
 * byte-sensitive cursor/dwell/alignment logic.*/
function emitWireRoute(
  ptb: PtbBundle,
  route: PtbBundle["routes"][number],
  canonical: number[],
  tripIdxs: number[],
  offsets: number[],
  sortedByTrip: Map<number, TripRows["rows"]>,
  stopIdOf: (idx: number) => string,
): PtbBundleWire["routes"][number] {
  // Parallel-array invariant guard (mirrors the Rust `build_one_index_route`
  // `debug_assert_eq!(member_pos.len(), offsets.len(), ...)`): `tripIdxs` and
  // `offsets` on a PatternGroup are 1:1. A future edit that pushes to one but
  // not the other would silently mis-align folded members to the wrong window;
  // fail loud at boot (cheap — once per wire-route) instead.
  if (tripIdxs.length !== offsets.length) {
    throw new Error(
      `emitWireRoute: tripIdxs/offsets length mismatch (${tripIdxs.length} vs ${offsets.length})`,
    );
  }
  const stopIds = canonical.map(stopIdOf);

  // stopIdx → LIST of canonical positions (ascending) — Pin 3. Lasso / loop
  // routes revisit a stop within one trip (canonical keeps the repeat), so
  // each occurrence must keep its own departure. Consume the positions in
  // stopSeq order via a per-trip cursor; a single-position map would leave the
  // outbound occurrence unserved. MUST mirror the Rust builder
  // (crates/pt-core/src/engine/index.rs) byte-for-byte or the engine-regression
  // diff is meaningless. GTFS best-practices — check the canonical case there:
  //   https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
  //   https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
  const positionsByStop = new Map<number, number[]>();
  canonical.forEach((stopIdx, pos) => {
    let positions = positionsByStop.get(stopIdx);
    if (!positions) { positions = []; positionsByStop.set(stopIdx, positions); }
    positions.push(pos);
  });

  const trips: PtbBundleWire["routes"][number]["trips"] = [];
  for (let mi = 0; mi < tripIdxs.length; mi++) {
    const t = tripIdxs[mi]!;
    const offset = offsets[mi]!;
    const departureSecs = new Array<number>(canonical.length).fill(-1);
    let dwellSecs: number[] | undefined;
    // Parallel to dwellSecs: sparse, canonical-aligned, lazy-alloc, omitted when
    // every value is default 0. The byte already rode the stopSeq sort on `row`.
    let pickupTypes: number[] | undefined;
    let dropOffTypes: number[] | undefined;
    if (offset > 0) {
      // CoveringMerge folded member: this shorter trip rides the longer pattern `canonical` at
      // window [offset, offset+rowCount). Its own stop sequence IS `canonical[offset..
      // offset+rowCount]` by the fold predicate (a contiguous subsequence), so row i lands at
      // position offset+i POSITIONALLY — no positionsByStop cursor (which would re-seek from
      // position 0 and mis-place rows when `canonical` repeats a stop). Positions [0, offset) and
      // [offset+rowCount, canonical.length) stay -1. MUST mirror the Rust builder byte-for-byte.
      const rows = sortedByTrip.get(t)!;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const pos = offset + i;
        // Occurrence slot consumed; a present-but-not-served row keeps the -1.
        if (row.depSecs === MISSING_DEP_SENTINEL) continue;
        departureSecs[pos] = row.depSecs;
        if (row.arrDiff < 0) {
          const dwell = -row.arrDiff;
          if (dwell > 0) {
            if (!dwellSecs) dwellSecs = new Array<number>(canonical.length).fill(0);
            dwellSecs[pos] = dwell;
          }
        }
        if (row.pickupType !== 0) {
          (pickupTypes ??= new Array<number>(canonical.length).fill(0))[pos] = row.pickupType;
        }
        if (row.dropOffType !== 0) {
          (dropOffTypes ??= new Array<number>(canonical.length).fill(0))[pos] = row.dropOffType;
        }
      }
      const trip = ptb.trips[t]!;
      trips.push({
        tripId: trip.tripId,
        serviceId: serviceIdFor(trip.serviceIdx),
        headsign: trip.headsign,
        ptbTripIdx: t,
        departureSecs,
        ...(dwellSecs ? { dwellSecs } : {}),
        ...(pickupTypes ? { pickupTypes } : {}),
        ...(dropOffTypes ? { dropOffTypes } : {}),
        ...(trip.wheelchairAccessible !== undefined
          ? { wheelchairAccessible: trip.wheelchairAccessible }
          : {}),
        ...(trip.bikesAllowed !== undefined
          ? { bikesAllowed: trip.bikesAllowed }
          : {}),
        ...(trip.shapeId ? { shapeId: trip.shapeId } : {}),
      });
      continue;
    }
    // offset === 0: native members (every member under Off/Unbounded) AND prefix
    // folds (offset 0) under CoveringMerge. A prefix fold's window starts at
    // canonical position 0, so the from-position-0 cursor lands its rows on the
    // SAME positions the positional branch would — they correctly take the cursor
    // path (mirrors the index.rs comment for the offset > 0 / offset 0 split).
    const cursor = new Map<number, number>();
    for (const row of sortedByTrip.get(t)!) {
      const positions = positionsByStop.get(row.stopIdx);
      if (positions === undefined) continue;
      const k = cursor.get(row.stopIdx) ?? 0;
      if (k >= positions.length) continue; // trip visits this stop more often than canonical
      const pos = positions[k]!;
      cursor.set(row.stopIdx, k + 1);
      // Occurrence slot consumed; a present-but-not-served row keeps the -1 so
      // downstream repeats stay aligned (mirrors index.rs's per-trip cursor).
      if (row.depSecs === MISSING_DEP_SENTINEL) continue;
      departureSecs[pos] = row.depSecs;
      if (row.arrDiff < 0) {
        const dwell = -row.arrDiff;
        if (dwell > 0) {
          if (!dwellSecs) dwellSecs = new Array<number>(canonical.length).fill(0);
          dwellSecs[pos] = dwell;
        }
      }
      if (row.pickupType !== 0) {
        (pickupTypes ??= new Array<number>(canonical.length).fill(0))[pos] = row.pickupType;
      }
      if (row.dropOffType !== 0) {
        (dropOffTypes ??= new Array<number>(canonical.length).fill(0))[pos] = row.dropOffType;
      }
    }
    const trip = ptb.trips[t]!;
    trips.push({
      tripId: trip.tripId,
      serviceId: serviceIdFor(trip.serviceIdx),
      headsign: trip.headsign,
      ...(trip.directionId === 0 || trip.directionId === 1
        ? { directionId: trip.directionId }
        : {}),
      ptbTripIdx: t,
      departureSecs,
      ...(dwellSecs ? { dwellSecs } : {}),
      ...(pickupTypes ? { pickupTypes } : {}),
      ...(dropOffTypes ? { dropOffTypes } : {}),
      ...(trip.wheelchairAccessible !== undefined
        ? { wheelchairAccessible: trip.wheelchairAccessible }
        : {}),
      ...(trip.bikesAllowed !== undefined
        ? { bikesAllowed: trip.bikesAllowed }
        : {}),
      ...(trip.shapeId ? { shapeId: trip.shapeId } : {}),
    });
  }

  // Match `hydrate`'s trip sort: ascending by departureSecs[0], with the
  // UNSERVED sentinel (now `-1` here) sorting first. `hydrate` sorts by
  // `a.departureSecs[0] - b.departureSecs[0]`, and our `-1` already encodes
  // the sentinel, so the comparison is identical to loadFromPtb.ts:455-458.
  // We sort here AND let hydrate sort again (idempotent — a stable resort of
  // an already-sorted array). Done here so the emitted wire is canonical.
  trips.sort((a, b) => a.departureSecs[0]! - b.departureSecs[0]!);

  return {
    id: route.routeId,
    shortName: route.routeShortName,
    mode: routeTypeToMode(route.routeType),
    color: route.routeColor || undefined,
    textColor: route.routeTextColor || undefined,
    stopIds,
    trips,
  };
}

/**
 * Reconstruct the display-only direction patterns Node's PTB loader exports.
 * Bucketing uses `(direction_id, trip_headsign)` because headsign is rider-facing
 * text, not direction identity; within each bucket the longest trip wins, with
 * first-in-route_trips as the stable tie-break. Repeated stops are preserved.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#tripstxt
 */
function buildDirectionPatterns(
  ptb: PtbBundle,
  tripIdxs: readonly number[],
  sortedByTrip: ReadonlyMap<number, TripRows["rows"]>,
  stopIdOf: (idx: number) => string,
): NonNullable<PtbBundleWire["routes"][number]["directionPatterns"]> {
  const groups = new Map<string, {
    key: string;
    headsign: string;
    tripIdxs: number[];
  }>();

  for (const tripIdx of tripIdxs) {
    const trip = ptb.trips[tripIdx]!;
    const directionKey = trip.directionId === 0 || trip.directionId === 1
      ? String(trip.directionId)
      : trip.headsign;
    const compositeKey = `${directionKey}\0${trip.headsign}`;
    let group = groups.get(compositeKey);
    if (!group) {
      group = { key: directionKey, headsign: trip.headsign, tripIdxs: [] };
      groups.set(compositeKey, group);
    }
    group.tripIdxs.push(tripIdx);
  }

  const patterns: NonNullable<PtbBundleWire["routes"][number]["directionPatterns"]> = [];
  for (const group of groups.values()) {
    const bestTripIdx = group.tripIdxs[0]!;
    let bestRows = sortedByTrip.get(bestTripIdx) ?? [];
    for (let i = 1; i < group.tripIdxs.length; i++) {
      const candidateIdx = group.tripIdxs[i]!;
      const candidateRows = sortedByTrip.get(candidateIdx) ?? [];
      if (candidateRows.length > bestRows.length) {
        bestRows = candidateRows;
      }
    }
    if (bestRows.length === 0) continue;
    patterns.push({
      key: group.key,
      headsign: group.headsign,
      stopIds: bestRows.map((row) => stopIdOf(row.stopIdx)),
    });
  }
  return patterns;
}

/**
 * Convert a decoded `PtbBundle` into a `PtbBundleWire`. Pure; no I/O.
 *
 * @param ptb
 * - Decoded PTB bundle.
 * @param mode
 * - PatternMode flag (default `Off`). When `Off`, emits one wire-route
 *   per `.ptb` route using the longest-trip canonical — identical to pre-pattern
 *   behavior. When `Unbounded`, emits one wire-route per distinct stop-sequence
 *   pattern (same `route_id` repeated across a route's patterns).
 */
export function ptbBundleToWire(
  ptb: PtbBundle,
  mode: PatternMode = PatternMode.Off,
  options: PtbBundleWireOptions = {},
): PtbBundleWire {
  const stopIdOf = (idx: number): string => {
    const s = ptb.stops[idx];
    if (!s) throw new Error(`ptbToBundleWire: stop idx ${idx} out of range`);
    return s.stopId;
  };

  // Group stop_times rows by trip via the tripStarts prefix-sum, preserving the
  // on-disk row order within each trip (Rust reads the same ranges).
  const tripRows: TripRows[] = [];
  for (let t = 0; t < ptb.trips.length; t++) {
    const lo = ptb.tripStarts[t]!;
    const hi = ptb.tripStarts[t + 1]!;
    const rows: TripRows["rows"] = [];
    for (let r = lo; r < hi; r++) {
      const st = ptb.stopTimes[r]!;
      // `ptb.boarding` is a flat column in the SAME global-row index space as
      // `ptb.stopTimes[r]` (loader.ts). Absent region ⇒ default 0x50 (pickup 0 /
      // drop_off 0 / continuous_* 1). Attach pickup/drop_off to the decoded row so
      // they ride the stopSeq sort below; `continuous_*` are not forwarded (YAGNI).
      const b = ptb.boarding?.[r] ?? 0x50;
      rows.push({
        stopIdx: st.stopIdx,
        stopSeq: st.stopSeq,
        depSecs: st.depSecs,
        arrDiff: st.arrDiff,
        pickupType: b & 0b11,
        dropOffType: (b >> 2) & 0b11,
      });
    }
    tripRows.push({ tripIdx: t, rows });
  }

  // B1.4 cutover (Design A): when patterns are enabled (Unbounded/CoveringMerge —
  // NEVER Off) AND the pattern band is present, source the per-route GROUPING
  // from the band (a TS port of Rust `build_from_band`); departures still come from
  // the flat stop-time rows via the UNCHANGED `emitWireRoute`. When the band is
  // absent (a staging bundle without `0x10`) the flat `groupTripsByPattern` path
  // runs verbatim. Off ALWAYS stays flat (the `patternsEnabled` gate
  // below excludes the band branch for Off regardless of band presence).
  const band = patternsEnabled(mode) ? ptb.patternBand : undefined;
  const tripPattern = band ? tripPatternFromBand(band, ptb.trips.length) : undefined;

  // Per-route trip lists straight from the route_trips CSR (route_idx order;
  // the values are trip ordinals in the writer's emitted order).
  // PTB v2 quarantined frequency trips are never routed, so they must not
  // reach this planner as their scheduled template either.
  const quarantined = new Set(ptb.v2?.quarantinedFrequencyTrips ?? []);
  const routes: PtbBundleWire["routes"] = [];
  for (let r = 0; r < ptb.routes.length; r++) {
    const route = ptb.routes[r]!;
    const lo = ptb.routeTripsOffsets[r]!;
    const hi = ptb.routeTripsOffsets[r + 1]!;
    const tripIdxs: number[] = [];
    for (let i = lo; i < hi; i++) {
      const t = ptb.routeTripsValues[i]!;
      if (!quarantined.has(t)) tripIdxs.push(t);
    }

    // Each trip's rows pre-sorted by stopSeq (stable) — mirrors
    // loadFromPtb.ts:420 / Pin 1 in the Rust Index.
    const sortedByTrip = new Map<number, TripRows["rows"]>();
    for (const t of tripIdxs) {
      const rows = [...tripRows[t]!.rows].sort((a, b) => a.stopSeq - b.stopSeq);
      sortedByTrip.set(t, rows);
    }
    const directionPatterns = options.includeDirectionPatterns
      ? buildDirectionPatterns(ptb, tripIdxs, sortedByTrip, stopIdOf)
      : [];
    const withDirectionPatterns = (
      wireRoute: PtbBundleWire["routes"][number],
    ): PtbBundleWire["routes"][number] => directionPatterns.length > 0
      ? { ...wireRoute, directionPatterns: directionPatterns.map((pattern) => ({
          ...pattern,
          stopIds: [...pattern.stopIds],
        })) }
      : wireRoute;

    if (patternsEnabled(mode)) {
      // One wire-route per signature group. The signature is the trip's own stopIdx sequence
      // (repeats preserved, including MISSING_DEP_SENTINEL rows), NOT canonical-aligned. Trips are
      // passed in route_trips order so the enumeration-order pin is respected.
      //
      // BAND-SOURCED (B1.4, Design A): when the pattern band is present the
      // grouping comes from the band (`groupFromBand`, mirroring Rust
      // `build_from_band`) — `pattern_idx` → `0x11 PatternStops`, grouped in
      // `route_trips` order; CoveringMerge folds the band groups identically. Else
      // the FLAT path runs (rollback). Either way the SAME `emitWireRoute` reads
      // departures from the flat rows (`sortedByTrip`).
      const groups =
        band && tripPattern
          ? groupFromBand(band, tripPattern, tripIdxs, mode)
          : groupTripsByPattern(
              tripIdxs.map((t) => ({
                tripIdx: t,
                stopIdxs: sortedByTrip.get(t)!.map((row) => row.stopIdx),
                boarding: sortedByTrip.get(t)!.map((row) => row.pickupType | (row.dropOffType << 2)),
              })),
              mode,
            );
      for (const g of groups) {
        routes.push(withDirectionPatterns(
          emitWireRoute(ptb, route, g.stopIdxs, g.tripIdxs, g.offsets, sortedByTrip, stopIdOf),
        ));
      }
    } else {
      // Off: canonical = longest trip (strict `>`; first in tripIdxs wins on tie),
      // all trips on one wire-route — identical to the pre-pattern behavior. Every
      // member is native → offset 0 (the positional fold path never triggers).
      let canonical: number[] = [];
      for (const t of tripIdxs) {
        const rows = sortedByTrip.get(t)!;
        if (rows.length > canonical.length) {
          canonical = rows.map((row) => row.stopIdx);
        }
      }
      const zeroOffsets = tripIdxs.map(() => 0);
      routes.push(withDirectionPatterns(
        emitWireRoute(ptb, route, canonical, tripIdxs, zeroOffsets, sortedByTrip, stopIdOf),
      ));
    }
  }

  // Calendar from the bitmask window (one entry per service ordinal). The window
  // length is the runtime `windowDays` from the loaded PTB (default 90 when the
  // `0x01` WindowMeta region is absent), NOT a hardcoded 90 — the wire calendar
  // is range-based (`startDate`/`endDate` + weekly `days[]` + per-day
  // `exceptions`), so widening `endDate` to `feedStartDate + windowDays - 1` is
  // exactly how a longer on-disk window reaches the on-device engine. A hardcoded
  // 90 would silently drop service days 90..windowDays-1 (the offline-device
  // benefit evaporates).
  //
  // PER-DAY FIDELITY (Step A.11). The per-day `bitmask` is the source of truth
  // (the native pt-core engine reads it directly). The weekly `days[]` base alone
  // (`deriveDays` = first occurrence of each weekday) is only an APPROXIMATION: it
  // reconstructs a clean weekly pattern and so DIVERGES from the bitmask wherever
  // the feed is non-weekly — (a) the always-sparse ~`windowDays - maxEnd` margin
  // tail (bitmask=0 there, but the weekly base marks the weekday active), and (b)
  // any `calendar_dates`-driven / non-weekly service. With the window now widened
  // (Step A), that divergence is a real correctness gap on the ts-raptor path
  // (the engines diverge: native reads the bitmask, the lossy weekly wire invents
  // or drops service). To close it we make the wire EXACT: keep the weekly base
  // (it minimises the exception count) and emit a `calendar_dates`-style exception
  // for EVERY window day where the bitmask disagrees with the weekly base —
  // `1` (added) where the bitmask is active but the weekday is off, `2` (removed)
  // where the bitmask is inactive but the weekday is on. The resolved active-set
  // (`serviceDay.resolveActiveServices`, which honours exceptions over the weekday
  // flag and composes with the [startDate,endDate] range) then equals the bitmask
  // across `[0, windowDays)`, so a widened window is per-day-faithful on the
  // ts-raptor path, not only pt-wasm. GTFS reference (calendar_dates exception
  // types 1=added / 2=removed): https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
  //
  // COST: exceptions are bounded by `windowDays` entries per service (worst case a
  // fully non-weekly feed). For a clean-weekly feed it is only the ~14-day margin
  // tail of removals; an all-active feed yields ZERO exceptions. This is an
  // acceptable wire-size cost for correctness (the alternative — dropping/inventing
  // service — is a silent routing bug).
  const calendar: PtbBundleWire["calendar"] = [];
  const bytesPer = bytesPerService(ptb.windowDays);
  const startDate = ymdToString(ptb.feedStartDate);
  const endDate = ymdToString(addDays(ptb.feedStartDate, ptb.windowDays - 1));
  for (let s = 0; s < ptb.numServices; s++) {
    const bitmask = ptb.serviceBitmasks.subarray(s * bytesPer, s * bytesPer + bytesPer);
    const days = deriveDays(bitmask, ptb.feedStartDate, ptb.windowDays);
    // Diff the per-day bitmask against the weekly base; record only the days that
    // disagree (the weekly base already covers the rest, keeping `exceptions` small).
    const exceptions: Record<string, number> = {};
    for (let n = 0; n < ptb.windowDays; n++) {
      const date = addDays(ptb.feedStartDate, n);
      const jsDay = new Date(
        Date.UTC(Math.floor(date / 10000), (Math.floor((date % 10000) / 100)) - 1, date % 100),
      ).getUTCDay(); // 0=Sun..6=Sat
      const monFirst = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon..6=Sun
      const active = bitmaskActive(bitmask, n);
      if (active !== days[monFirst]) {
        exceptions[ymdToString(date)] = active ? 1 : 2; // GTFS: 1=added, 2=removed
      }
    }
    calendar.push({
      serviceId: serviceIdFor(s),
      days,
      startDate,
      endDate,
      exceptions,
    });
  }

  const stops: PtbBundleWire["stops"] = ptb.stops.map((s) => ({
    id: s.stopId,
    name: s.stopName,
    lat: s.stopLat,
    lon: s.stopLon,
    ...(s.wheelchairBoarding !== undefined ? { wheelchairBoarding: s.wheelchairBoarding } : {}),
  }));

  // GTFS transfers.txt: resolve the interner ordinals back to the string ids
  // the engine index keys by. Scoped optional fields (route/trip) are carried
  // for forward-compat; `hydrate` routes each row into its scoped map
  // (trip-scoped / route-scoped) or the unscoped map (S3). An undefined
  // optional index decodes to undefined (PtbTransfer already maps the on-disk
  // 0xFFFFFFFF sentinel to undefined). GTFS reference:
  // https://gtfs.org/documentation/schedule/reference/#transferstxt
  // A defined-but-out-of-range scope index is producer/loader drift or a corrupt
  // region, NOT an absent scope (the 0xFFFFFFFF sentinel was already mapped to
  // undefined by loadPtb). Throw — symmetric with stopIdOf above, loadFromPtb's
  // synthTransfers, and the Rust Index::build bounds check. Silently returning
  // undefined here would broaden a scoped rule to all-routes/all-trips.
  const routeIdOf = (idx: number | undefined): string | undefined => {
    if (idx === undefined) return undefined;
    const r = ptb.routes[idx];
    if (!r) throw new Error(`ptbToBundleWire: transfer route idx ${idx} out of range`);
    return r.routeId;
  };
  const tripIdOf = (idx: number | undefined): string | undefined => {
    if (idx === undefined) return undefined;
    const t = ptb.trips[idx];
    if (!t) throw new Error(`ptbToBundleWire: transfer trip idx ${idx} out of range`);
    return t.tripId;
  };
  // An absent stop (PTB v2 linked row) stays absent; a present index still
  // goes through stopIdOf's out-of-range throw.
  const optStopIdOf = (idx: number | undefined): string | undefined =>
    idx === undefined ? undefined : stopIdOf(idx);
  const transfers: WireTransfer[] = ptb.transfers.map((t) => ({
    ...(t.fromStopIdx !== undefined ? { fromStopId: optStopIdOf(t.fromStopIdx) } : {}),
    ...(t.toStopIdx !== undefined ? { toStopId: optStopIdOf(t.toStopIdx) } : {}),
    transferType: t.transferType,
    ...(t.minTransferSecs !== undefined ? { minTransferSecs: t.minTransferSecs } : {}),
    ...(routeIdOf(t.fromRouteIdx) !== undefined ? { fromRouteId: routeIdOf(t.fromRouteIdx) } : {}),
    ...(routeIdOf(t.toRouteIdx) !== undefined ? { toRouteId: routeIdOf(t.toRouteIdx) } : {}),
    ...(tripIdOf(t.fromTripIdx) !== undefined ? { fromTripId: tripIdOf(t.fromTripIdx) } : {}),
    ...(tripIdOf(t.toTripIdx) !== undefined ? { toTripId: tripIdOf(t.toTripIdx) } : {}),
  }));

  const frequencies: WireFrequency[] | undefined = ptb.frequencies?.map((f) => ({
    tripIdx: f.tripIdx,
    startSecs: f.startSecs,
    endSecs: f.endSecs,
    headwaySecs: f.headwaySecs,
    exactTimes: wireExactTimes(f.exactTimes, f.tripIdx),
  }));

  return {
    version: ptb.version,
    meta: { generatedAt: new Date(0).toISOString() },
    routes,
    calendar,
    stops,
    ...(transfers.length > 0 ? { transfers } : {}),
    ...(frequencies && frequencies.length > 0 ? { frequencies } : {}),
  };
}
