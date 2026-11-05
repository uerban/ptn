import type { Departure, LatLon } from "@pt/shared";
import { haversineDistance } from "../utils/geo.ts";
import type { RaptorIndex, RaptorIndexRoute } from "./raptorIndex.ts";
import { groupStops, type StopForGrouping } from "./stopGrouping.ts";

/**
 * Pairing of the lines at the nearest stop with their opposite direction, for
 * the ETA strip on the map.
 *
 * Direction identity is decided PER PATTERN, never per trip. GTFS
 * `trips.direction_id` is the timetable field that separates the two
 * directions of a route (`trip_headsign` is rider-facing text and two
 * directions may share it), so it wins whenever the pattern's trips carry it;
 * the headsign is only the fallback for feeds that omit it:
 * https://gtfs.org/documentation/schedule/reference/#tripstxt
 *
 * A single-direction loop route models the whole round trip as one trip
 * (https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes),
 * so it has one direction key and therefore no opposite.
 */

/**
 * `"d0"` / `"d1"` (GTFS direction_id), `"h:<headsign>"`, or `ANY_DIR` (`"*"`)
 * for a route-level side at the nearest stop (`routeSidesAt`).
 */
export type DirKey = string;

/**
 * Direction key of a route-level side at the nearest stop: a route whose
 * directions cannot be told apart there (no pattern index, or the index does
 * not list the route at that stop) gets one side for all of them.
 */
export const ANY_DIR: DirKey = "*";

export interface PatternDirKeys {
  /** index into `RaptorIndex.patterns` → that pattern's direction key. */
  byPattern: Map<number, DirKey>;
  /** trip_id → the direction key of the pattern the trip rides. */
  byTrip: Map<string, DirKey>;
  /** route_id → indices into `RaptorIndex.patterns`, ascending. */
  byRoute: Map<string, number[]>;
}

const EMPTY_KEYS: PatternDirKeys = {
  byPattern: new Map(),
  byTrip: new Map(),
  byRoute: new Map(),
};

// Keyed on the `patterns` array: it is rebuilt with every index, so a new
// index never reads a stale entry, and a caller that re-wraps the same index
// still hits.
const keysMemo = new WeakMap<RaptorIndexRoute[], PatternDirKeys>();

/**
 * The pattern's most frequent headsign among the trips that serve its first
 * position (its own offset-0 trips); ties break lexically. Falls back to every
 * trip when none serves position 0.
 */
function patternHeadsign(pattern: RaptorIndexRoute): string {
  const own = pattern.trips.filter((t) => (t.departureSecs[0] ?? -1) >= 0);
  const counts = new Map<string, number>();
  for (const t of own.length > 0 ? own : pattern.trips) {
    counts.set(t.headsign, (counts.get(t.headsign) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [headsign, count] of counts) {
    if (count > bestCount || (count === bestCount && headsign < best)) {
      best = headsign;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Direction key of one pattern:
 * - the `direction_id` shared by every trip that carries one; trips without
 *   it are ignored — under `PatternMode.CoveringMerge` a shorter trip folded
 *   into a longer pattern loses its direction_id in the wire converter
 *   (`packages/shared/src/ptb/ptbToBundleWire.ts`, the `offset > 0` branch),
 *   so a pattern's trips can carry it only partially;
 * - when no trip carries one, or the carried values conflict, the headsign of
 *   the pattern's own offset-0 trips (see `patternHeadsign`).
 */
function patternDirKey(pattern: RaptorIndexRoute): DirKey {
  const carried = new Set<0 | 1>();
  for (const t of pattern.trips) {
    if (t.directionId !== undefined) carried.add(t.directionId);
  }
  if (carried.size === 1) return `d${[...carried][0]}`;
  return `h:${patternHeadsign(pattern)}`;
}

/**
 * Direction keys for every pattern of the index, and for every trip through
 * the pattern it rides (a folded trip takes its pattern's key, whatever its
 * own fields say). Memoised per index. Empty when `patterns` is absent
 * (PatternMode Off, Dexie fallback index).
 */
export function patternDirKeys(index: Pick<RaptorIndex, "patterns">): PatternDirKeys {
  const patterns = index.patterns;
  if (!patterns) return EMPTY_KEYS;
  const cached = keysMemo.get(patterns);
  if (cached) return cached;

  const keys: PatternDirKeys = { byPattern: new Map(), byTrip: new Map(), byRoute: new Map() };
  patterns.forEach((pattern, idx) => {
    const key = patternDirKey(pattern);
    keys.byPattern.set(idx, key);
    for (const t of pattern.trips) {
      if (!keys.byTrip.has(t.tripId)) keys.byTrip.set(t.tripId, key);
    }
    const ofRoute = keys.byRoute.get(pattern.id);
    if (ofRoute) ofRoute.push(idx);
    else keys.byRoute.set(pattern.id, [idx]);
  });
  keysMemo.set(patterns, keys);
  return keys;
}

const isHeadsignKey = (key: DirKey): boolean => key.startsWith("h:");

/**
 * Patterns of `routeId` running opposite to `dirKey`, seen from `stopId`:
 * every pattern of the route with a different direction key. When either key
 * is a headsign key the candidate must also not pass through `stopId` — two
 * headsigns through the same stop are branches of one direction far more often
 * than two directions. A `direction_id` pair is trusted as is (a terminus
 * served by both directions keeps its opposite). Ascending pattern indices;
 * empty for an unknown route, a single-direction route, or no `patterns`.
 */
export function oppositePatterns(
  index: Pick<RaptorIndex, "patterns">,
  routeId: string,
  dirKey: DirKey,
  stopId: string,
): number[] {
  const patterns = index.patterns;
  if (!patterns) return [];
  const keys = patternDirKeys(index);
  const out: number[] = [];
  for (const idx of keys.byRoute.get(routeId) ?? []) {
    const key = keys.byPattern.get(idx)!;
    if (key === dirKey) continue;
    if ((isHeadsignKey(key) || isHeadsignKey(dirKey)) && patterns[idx].stopIds.includes(stopId)) {
      continue;
    }
    out.push(idx);
  }
  return out;
}

/** A line in one direction: GTFS route_id + the direction key of its pattern. */
export interface Line {
  routeId: string;
  dirKey: DirKey;
}

/** Reverse stops are searched within this distance of the user. */
export const REVERSE_STOP_RADIUS_M = 500;

export interface ReverseStopContext {
  index: Pick<RaptorIndex, "patterns">;
  user: LatLon;
  /** Stop lookup (the in-memory stop store); unknown stops are skipped. */
  getStop: (id: string) => StopForGrouping | undefined;
  /**
   * Stops the search must not pick. `resolveNearbySides` passes the stops of
   * the other row only, so two lines can share one reverse stop.
   */
  assigned: ReadonlySet<string>;
}

export interface ReverseStop {
  stopId: string;
  /** Direction keys of the line's opposite patterns serving `stopId`, sorted. */
  dirKeys: DirKey[];
}

/** Closest to the user; a distance tie breaks by the lowest stopId. */
function closestToUser(stops: StopForGrouping[], user: LatLon): StopForGrouping | undefined {
  let best: StopForGrouping | undefined;
  let bestDist = Infinity;
  for (const stop of stops) {
    const dist = haversineDistance(user, stop);
    if (dist < bestDist || (dist === bestDist && best !== undefined && stop.id < best.id)) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

const hasParent = (stop: StopForGrouping): boolean => Boolean(stop.parentStation);

/**
 * The ids in `origin`'s stop group (`groupStops` over the origin +
 * `candidates`). `parent_station` is only known for stops that came from the
 * server, and `groupStops` groups a stop that has one by it alone, so a pole
 * with a parent and its same-name neighbour without one would never meet:
 * candidates whose parent presence differs from the origin's are grouped with
 * it once more by name alone (a numbered suffix, or the same name within
 * 150 m). Two different parents stay apart.
 */
function originGroup(origin: StopForGrouping, candidates: StopForGrouping[]): Set<string> {
  const members = new Set<string>();
  const addGroupOf = (stops: StopForGrouping[]): void => {
    // The origin goes first so it seeds its own same-name cluster.
    const group = groupStops(stops).find((g) => g.stopIds.includes(origin.id));
    for (const id of group?.stopIds ?? []) members.add(id);
  };
  addGroupOf([origin, ...candidates]);
  const mixed = candidates.filter((c) => hasParent(c) !== hasParent(origin));
  if (mixed.length > 0) {
    const byName = (s: StopForGrouping): StopForGrouping => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
    addGroupOf([byName(origin), ...mixed.map(byName)]);
  }
  return members;
}

/**
 * Where to catch `line`'s opposite direction, searched from `fromStopId`.
 *
 * Candidates are the stops of the line's opposite patterns (see
 * `oppositePatterns`, whose through-stop guard is applied at `fromStopId`)
 * within `REVERSE_STOP_RADIUS_M` of the user, minus the stops already assigned
 * to a row, the origin itself, and stops `getStop` does not know. Then:
 * 1. candidates in the origin's stop group — `groupStops` over the origin +
 *    candidates: a shared GTFS `parent_station`
 *    (https://gtfs.org/documentation/schedule/reference/#stopstxt), a numbered
 *    suffix, or the same name within 150 m; see `originGroup` for a pair of
 *    which only one side knows its parent — the one closest to the user. The
 *    radius is applied before grouping: the first two strategies have no
 *    distance bound of their own;
 * 2. else the candidate closest to the user (a one-way street pair, whose two
 *    stops rarely share a name);
 * 3. else none.
 * There is deliberately no "plain closest stop" tier: per line it would
 * produce a pill for a different line. Distance ties break by the lowest
 * stopId.
 */
export function reverseStopFor(
  line: Line,
  fromStopId: string,
  ctx: ReverseStopContext,
): ReverseStop | null {
  const patterns = ctx.index.patterns;
  if (!patterns) return null;
  const opposite = oppositePatterns(ctx.index, line.routeId, line.dirKey, fromStopId);
  if (opposite.length === 0) return null;

  const candidates: StopForGrouping[] = [];
  const seen = new Set<string>([fromStopId]);
  for (const idx of opposite) {
    for (const stopId of patterns[idx].stopIds) {
      if (seen.has(stopId)) continue;
      seen.add(stopId);
      if (ctx.assigned.has(stopId)) continue;
      const stop = ctx.getStop(stopId);
      if (!stop || haversineDistance(ctx.user, stop) > REVERSE_STOP_RADIUS_M) continue;
      candidates.push(stop);
    }
  }
  if (candidates.length === 0) return null;

  let picked: StopForGrouping | undefined;
  const origin = ctx.getStop(fromStopId);
  if (origin) {
    const members = originGroup(origin, candidates);
    picked = closestToUser(candidates.filter((c) => members.has(c.id)), ctx.user);
  }
  picked ??= closestToUser(candidates, ctx.user);
  if (!picked) return null;

  const keys = patternDirKeys(ctx.index);
  const dirKeys = new Set<DirKey>();
  for (const idx of opposite) {
    if (patterns[idx].stopIds.includes(picked.id)) dirKeys.add(keys.byPattern.get(idx)!);
  }
  return { stopId: picked.id, dirKeys: [...dirKeys].sort() };
}

/** Strip row: `top` = the nearest stop's side of the street, `bottom` = the opposite one. */
export type Row = "top" | "bottom";

/** One line in one direction, caught at one stop, shown in one row. */
export interface Side {
  stopId: string;
  routeId: string;
  dirKey: DirKey;
  row: Row;
}

export interface NearbyDirectionsInput {
  index: Pick<RaptorIndex, "patterns" | "patternsAtStop">;
  nearestStopId: string;
  user: LatLon;
  /** Backed by the in-memory stop store; unknown stops are skipped. */
  getStop: (id: string) => StopForGrouping | undefined;
}

const lineKey = (routeId: string, dirKey: DirKey): string => `${routeId}\t${dirKey}`;

function compareLines(a: Line, b: Line): number {
  if (a.routeId !== b.routeId) return a.routeId < b.routeId ? -1 : 1;
  if (a.dirKey !== b.dirKey) return a.dirKey < b.dirKey ? -1 : 1;
  return 0;
}

/**
 * The lines whose patterns serve `stopId`, once each (a lasso pattern visiting
 * the stop twice is listed once by `patternsAtStop`), sorted by routeId then
 * dirKey so the output never depends on the order of `patterns`.
 */
function linesAtStop(index: Pick<RaptorIndex, "patterns" | "patternsAtStop">, stopId: string): Line[] {
  const patterns = index.patterns;
  const at = index.patternsAtStop?.get(stopId);
  if (!patterns || !at) return [];
  const keys = patternDirKeys(index);
  const seen = new Set<string>();
  const out: Line[] = [];
  for (const idx of at) {
    const line = { routeId: patterns[idx].id, dirKey: keys.byPattern.get(idx)! };
    const id = lineKey(line.routeId, line.dirKey);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(line);
  }
  return out.sort(compareLines);
}

/**
 * Every line at the nearest stop `S` with its opposite direction, for the two
 * strip rows. Breadth-first, so a row always follows hop parity, never
 * distance:
 * - hop 0: every line whose pattern serves `S` → `top` at `S` (a pattern
 *   ending at `S` seeds too: its return trip usually leaves from a nearby
 *   stop, which is exactly the reverse pill wanted; a lasso pattern visiting
 *   `S` twice — https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes —
 *   seeds once);
 * - hop 1: each seed's reverse stop (`reverseStopFor` from `S`) → `bottom`,
 *   one side per opposite direction key serving it; then the extra lines
 *   serving those reverse stops → `bottom` too;
 * - hop 2: each extra line's reverse stop, searched from the stop the extra
 *   was found at → `top`. One round only: lines serving these stops are not
 *   added.
 * First assignment wins for a stop (a search never picks a stop of the other
 * row) and for a `(routeId, dirKey)` (never shown twice: a terminus serving
 * both directions keeps both in `top`). Output is in assignment order, seeds
 * and extras sorted by routeId then dirKey. Empty when `S` is unknown to
 * `patternsAtStop` or `patterns` is absent (PatternMode Off, Dexie fallback).
 */
export function resolveNearbySides(input: NearbyDirectionsInput): Side[] {
  const { index, nearestStopId, user, getStop } = input;
  const sides: Side[] = [];
  const sided = new Set<string>();
  const stopsIn: Record<Row, Set<string>> = { top: new Set(), bottom: new Set() };

  const add = (stopId: string, line: Line, row: Row): Side | null => {
    const id = lineKey(line.routeId, line.dirKey);
    if (sided.has(id)) return null;
    sided.add(id);
    stopsIn[row].add(stopId);
    const s: Side = { stopId, routeId: line.routeId, dirKey: line.dirKey, row };
    sides.push(s);
    return s;
  };

  const addReverse = (s: Side, row: Row): void => {
    const found = reverseStopFor(s, s.stopId, {
      index,
      user,
      getStop,
      assigned: stopsIn[row === "top" ? "bottom" : "top"],
    });
    if (!found) return;
    for (const dirKey of found.dirKeys) add(found.stopId, { routeId: s.routeId, dirKey }, row);
  };

  const seeds: Side[] = [];
  for (const line of linesAtStop(index, nearestStopId)) {
    const s = add(nearestStopId, line, "top");
    if (s) seeds.push(s);
  }

  for (const seed of seeds) addReverse(seed, "bottom");

  const extras: Side[] = [];
  for (const stopId of [...stopsIn.bottom]) {
    for (const line of linesAtStop(index, stopId)) {
      const s = add(stopId, line, "bottom");
      if (s) extras.push(s);
    }
  }

  for (const extra of extras) addReverse(extra, "top");
  return sides;
}

/**
 * One `top` side at `stopId` (`ANY_DIR`) for every route of `departures` that
 * has no side there yet, in order of first departure. With no sides at all
 * (no pattern index, or `stopId` unknown to it) that is every route: the
 * single row the strip showed before it had rows. Together with
 * `assignDeparturesToSides`' `nearestStopId` fallback, no departure at the
 * nearest stop is lost.
 */
export function routeSidesAt(stopId: string, departures: Departure[], sides: Side[]): Side[] {
  const seen = new Set<string>();
  for (const s of sides) if (s.stopId === stopId) seen.add(s.routeId);
  const out: Side[] = [];
  for (const d of departures) {
    if (seen.has(d.routeId)) continue;
    seen.add(d.routeId);
    out.push({ stopId, routeId: d.routeId, dirKey: ANY_DIR, row: "top" });
  }
  return out;
}

export interface AssignDeparturesOptions {
  /**
   * The nearest stop. There a departure the rules below would drop goes to
   * its route's first side instead: the strip showed every departure of the
   * nearest stop before it had rows, and a trip the index cannot place (tiles
   * from a newer bundle than the index, until the next refresh) is still a
   * bus leaving from there.
   */
  nearestStopId?: string;
}

/**
 * Departures per side. A departure joins through its trip: `keys.byTrip` gives
 * the direction key of the pattern the trip rides, so a CoveringMerge folded
 * trip without its own GTFS `direction_id`
 * (https://gtfs.org/documentation/schedule/reference/#tripstxt) still lands on
 * its pattern's side. A trip unknown to the index (from the
 * `departures-for-stop` fallback, or a tile newer than the index) joins by
 * route only when that route has exactly one side at that stop; otherwise it
 * is dropped, never shown twice — except at `opts.nearestStopId` (see there).
 * Departures keep their input order; stops without a side are ignored; every
 * side gets an entry (empty when nothing joined).
 */
export function assignDeparturesToSides(
  sides: Side[],
  departuresByStop: Map<string, Departure[]>,
  keys: Pick<PatternDirKeys, "byTrip">,
  opts: AssignDeparturesOptions = {},
): Map<Side, Departure[]> {
  const out = new Map<Side, Departure[]>();
  const atStop = new Map<string, Side[]>();
  for (const s of sides) {
    out.set(s, []);
    const list = atStop.get(s.stopId);
    if (list) list.push(s);
    else atStop.set(s.stopId, [s]);
  }

  for (const [stopId, departures] of departuresByStop) {
    const here = atStop.get(stopId);
    if (!here) continue;
    for (const d of departures) {
      const dirKey = keys.byTrip.get(d.tripId);
      const ofRoute = here.filter((s) => s.routeId === d.routeId);
      let target =
        dirKey !== undefined
          ? ofRoute.find((s) => s.dirKey === dirKey)
          : ofRoute.length === 1 ? ofRoute[0] : undefined;
      if (!target && stopId === opts.nearestStopId) target = ofRoute[0];
      if (target) out.get(target)!.push(d);
    }
  }
  return out;
}
