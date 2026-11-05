import {
  TILE_EDGE_KM,
  SCHEDULE_TILE_EDGE_KM,
  TILE_OVERLAP_RATIO,
  MAX_SUBDIVISION_DEPTH,
} from "./tileParams.js";
import type { SubdivisionPlan } from "../types/scheduleTile.js";

const KM_PER_DEG_LAT = 111.32;

function kmPerDegLon(latDeg: number): number {
  return KM_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface TileCoord {
  x: number;
  y: number;
}

/** City-anchored grid origin. `refLat` is the bbox-CENTER latitude, used ONLY to
 *  scale longitude degrees so cells stay ~square; it does NOT shift the lat axis. */
export interface TileAnchor { minLat: number; minLon: number; refLat: number; }

/** Default = today's global grid: zero origin, per-row (latitude-derived) lon
 *  scaling (signalled by refLat = NaN). Exported as the single source of truth
 *  so build-side callers don't redefine it. */
export const GLOBAL_ANCHOR: TileAnchor = { minLat: 0, minLon: 0, refLat: Number.NaN };

// URL/storage-key segment. Distinct labels keep the POI and schedule-tile
// key spaces disjoint at the cache and routing layers. `as const` narrows
// each to a literal string type so route handlers can express
// `tileSize: typeof TILE_SIZE_LABEL` for compile-time route validation.
export const TILE_SIZE_LABEL = `${TILE_EDGE_KM}km` as const;
export const SCHEDULE_TILE_SIZE_LABEL = `${SCHEDULE_TILE_EDGE_KM}km` as const;

function stepLatDeg(edgeKm: number): number {
  return edgeKm / KM_PER_DEG_LAT;
}

function halfLatDeg(edgeKm: number): number {
  return (edgeKm * (1 + TILE_OVERLAP_RATIO)) / (2 * KM_PER_DEG_LAT);
}

function centerLatForRow(y: number, edgeKm: number): number {
  return (y + 0.5) * stepLatDeg(edgeKm);
}

function stepLonDegForRow(y: number, edgeKm: number): number {
  return edgeKm / kmPerDegLon(centerLatForRow(y, edgeKm));
}

function halfLonDegForRow(y: number, edgeKm: number): number {
  return (
    (edgeKm * (1 + TILE_OVERLAP_RATIO)) /
    (2 * kmPerDegLon(centerLatForRow(y, edgeKm)))
  );
}

function tileCoordAtImpl(lat: number, lon: number, edgeKm: number, anchor: TileAnchor): TileCoord {
  const stepLat = stepLatDeg(edgeKm);
  const y = Math.floor((lat - anchor.minLat) / stepLat);
  const refLat = Number.isNaN(anchor.refLat)
    ? anchor.minLat + (y + 0.5) * stepLat   // global: per-row center (≡ today for minLat=0)
    : anchor.refLat;                         // city: fixed bbox-center latitude
  const stepLon = edgeKm / kmPerDegLon(refLat);
  const x = Math.floor((lon - anchor.minLon) / stepLon);
  return { x, y };
}

// POI tile axis (12 km grid).
export function tileCoordAt(lat: number, lon: number, edgeKm: number = TILE_EDGE_KM, anchor: TileAnchor = GLOBAL_ANCHOR): TileCoord {
  return tileCoordAtImpl(lat, lon, edgeKm, anchor);
}

export function tileKeyAt(cityId: string, lat: number, lon: number, edgeKm: number = TILE_EDGE_KM, anchor: TileAnchor = GLOBAL_ANCHOR): string {
  const { x, y } = tileCoordAtImpl(lat, lon, edgeKm, anchor);
  return `${cityId}/${edgeKm}km/${x}_${y}`;
}

export function tilesForViewport(cityId: string, bbox: Bbox, edgeKm: number = TILE_EDGE_KM, anchor: TileAnchor = GLOBAL_ANCHOR): string[] {
  const step = stepLatDeg(edgeKm);
  const half = halfLatDeg(edgeKm);
  const yMin = Math.floor((bbox.minLat - anchor.minLat - half) / step);
  const yMax = Math.ceil((bbox.maxLat - anchor.minLat + half) / step);
  const keys: string[] = [];
  for (let y = yMin; y <= yMax; y++) {
    const refLat = Number.isNaN(anchor.refLat) ? anchor.minLat + (y + 0.5) * step : anchor.refLat;
    const stepLon = edgeKm / kmPerDegLon(refLat);
    const halfLon = (edgeKm * (1 + TILE_OVERLAP_RATIO)) / (2 * kmPerDegLon(refLat));
    const xMin = Math.floor((bbox.minLon - anchor.minLon - halfLon) / stepLon);
    const xMax = Math.ceil((bbox.maxLon - anchor.minLon + halfLon) / stepLon);
    for (let x = xMin; x <= xMax; x++) keys.push(`${cityId}/${edgeKm}km/${x}_${y}`);
  }
  return keys;
}

// Schedule + RT tile axis (6 km grid). Only `scheduleTileCoordAt` is exported
// today — the schedule pipeline is server-side and consumers in
// `groupStopsByCell` / `isOwningTile` need cell-coord math, not key strings or
// viewport enumeration. `scheduleTileKeyAt` / `scheduleTilesForViewport` will
// land alongside the first frontend consumer of `/api/gtfs/schedule-tile/`.
export function scheduleTileCoordAt(lat: number, lon: number): TileCoord {
  return tileCoordAtImpl(lat, lon, SCHEDULE_TILE_EDGE_KM, GLOBAL_ANCHOR);
}

/**
 * Inverse of {@link scheduleTileCoordAt}: the lat/lon bounds of the 6 km cell
 * `(x, y)` on the global grid. Uses the SAME per-row projection as
 * `tileCoordAtImpl` (GLOBAL_ANCHOR, per-row center latitude for the lon step) so
 * `scheduleTileCoordAt(midLat, midLon) === {x, y}` round-trips exactly. Anchor is
 * the ORIGIN (minLat=minLon=0).
 */
export function scheduleCellBounds(x: number, y: number): Bbox {
  const stepLat = stepLatDeg(SCHEDULE_TILE_EDGE_KM);
  const minLat = y * stepLat;
  const maxLat = (y + 1) * stepLat;
  const stepLon = stepLonDegForRow(y, SCHEDULE_TILE_EDGE_KM);
  const minLon = x * stepLon;
  const maxLon = (x + 1) * stepLon;
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Quadrant digit for a point inside `bbox`, per the NORMATIVE tie-break:
 * `north = lat >= midLat`, `east = lon >= midLon`, `digit = (north?2:0)+(east?1:0)`
 * ⇒ {0:SW, 1:SE, 2:NW, 3:NE}. Half-open, upper-closed (a point exactly on a split
 * plane goes to the upper child) so it matches `Math.floor`'s grid convention.
 * Build side and the future RT point→leaf descent MUST use this identical predicate.
 */
export function quadrantDigitForPoint(bbox: Bbox, lat: number, lon: number): 0 | 1 | 2 | 3 {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLon = (bbox.minLon + bbox.maxLon) / 2;
  const north = lat >= midLat ? 2 : 0;
  const east = lon >= midLon ? 1 : 0;
  return (north + east) as 0 | 1 | 2 | 3;
}

/**
 * Child bbox for quadrant `digit` of `bbox` — an EXACT bisection of the parent
 * bounds. NEVER recompute the child from a child mid-latitude (sub-cells live
 * inside one parent row, so the lon step stays the parent's). This is what keeps
 * the split bit-deterministic across builds.
 */
export function bisectQuadrant(bbox: Bbox, digit: 0 | 1 | 2 | 3): Bbox {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLon = (bbox.minLon + bbox.maxLon) / 2;
  const north = (digit & 2) !== 0;
  const east = (digit & 1) !== 0;
  return {
    minLat: north ? midLat : bbox.minLat,
    maxLat: north ? bbox.maxLat : midLat,
    minLon: east ? midLon : bbox.minLon,
    maxLon: east ? bbox.maxLon : midLon,
  };
}

/**
 * Quadtree-path suffix (e.g. `"3-0"`) of the leaf at `depth` that a point lands
 * in, descending from `cellBounds`. `depth === 0` ⇒ `""` (the unsplit cell). The
 * single function both the build side and (in PR 2b-2) the RT owner call, so the
 * leaf a stop was written into and the leaf an RT request resolves are identical
 * by construction.
 */
export function leafSuffixForPoint(cellBounds: Bbox, lat: number, lon: number, depth: number): string {
  let bounds = cellBounds;
  const digits: number[] = [];
  for (let d = 0; d < depth; d++) {
    const digit = quadrantDigitForPoint(bounds, lat, lon);
    digits.push(digit);
    bounds = bisectQuadrant(bounds, digit);
  }
  return digits.join("-");
}

/**
 * Single shared coord regex, bound built FROM `MAX_SUBDIVISION_DEPTH` (S10) so a
 * depth bump widens it automatically. Matches the bare cell `<x>_<y>` and a leaf
 * `<x>_<y>-<suffix>` where the suffix is 1..MAX_SUBDIVISION_DEPTH digits in 0..3.
 * Negative coords have a `-` right after `_`, so the prefix is `-?\d{1,6}` — never
 * dash-split (S2).
 */
export const TILE_COORD_RE = new RegExp(
  `^-?\\d{1,6}_-?\\d{1,6}(?:-[0-3]){0,${MAX_SUBDIVISION_DEPTH}}$`,
);

// Capturing form: group1 = `<x>_<y>` cell key, group2 = the leaf suffix (absent ⇒
// bare cell). Anchored on the numeric prefix so a leading `-` in x or y can never
// be mistaken for a suffix delimiter (S2). The inner repeat is MAX_SUBDIVISION_DEPTH-1
// because the first digit is captured by `[0-3]`.
const TILE_COORD_CAPTURE_RE = new RegExp(
  `^(-?\\d{1,6}_-?\\d{1,6})(?:-([0-3](?:-[0-3]){0,${MAX_SUBDIVISION_DEPTH - 1}}))?$`,
);

/**
 * Parse a tile coord into its `<x>_<y>` cell key and quadtree suffix. Returns
 * `null` for any string the shared regex rejects (over-depth, digit > 3, trailing
 * dash). `suffix` is `""` for a bare cell.
 */
export function parseTileCoords(
  coords: string,
): { cellKey: string; suffix: string } | null {
  const m = TILE_COORD_CAPTURE_RE.exec(coords);
  if (!m) return null;
  return { cellKey: m[1]!, suffix: m[2] ?? "" };
}

/** The ONE place a plan's leaf-suffix Set is derived (used by both routes, the
 *  consumer, and tests). Invariant: build leaves are a prefix-free antichain and
 *  never contain `""` (S4). */
export function leafSuffixSet(plan: SubdivisionPlan): ReadonlySet<string> {
  return new Set(plan.leaves.map((l) => l.suffix));
}

/**
 * Descend `cellBounds` toward `(lat, lon)` accumulating the quadtree suffix, and
 * return as soon as the accumulated suffix ∈ `leafSuffixes`. Returns `null` on no
 * match within `MAX_SUBDIVISION_DEPTH` or when `leafSuffixes` is empty (S4). ONE
 * pinned signature — positional scalar `(lat, lon)`. Uses the existing normative
 * `quadrantDigitForPoint`/`bisectQuadrant` primitives so the leaf a stop was
 * written into and the leaf a request resolves are identical by construction.
 */
export function leafForPoint(
  cellBounds: Bbox,
  lat: number,
  lon: number,
  leafSuffixes: ReadonlySet<string>,
): string | null {
  if (leafSuffixes.size === 0) return null;
  let bounds = cellBounds;
  const digits: number[] = [];
  for (let d = 0; d < MAX_SUBDIVISION_DEPTH; d++) {
    const digit = quadrantDigitForPoint(bounds, lat, lon);
    digits.push(digit);
    const suffix = digits.join("-");
    if (leafSuffixes.has(suffix)) return suffix;
    bounds = bisectQuadrant(bounds, digit);
  }
  return null;
}
