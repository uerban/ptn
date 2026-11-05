import type { LabelAnchor } from "@pt/shared";
import type { GtfsStop } from "./parser.js";

export type { LabelAnchor };

// ── Stop-label placement solver core (Stage 1) ───────────────────────────────
//
// Precomputes one anchor direction per stop: repulsion supplies a preferred
// direction, then pure pairs and clusters coordinate their assignments.
// A spatial grid limits neighbor searches to nearby cells. Both phases retain
// their own distance predicates and input-order tie-breaks.

/**
 * Index basis: `DIRS[angleToIdx(angle)]`. Matches the
 * `LabelAnchor` union order in `@pt/shared` — keep the two in sync.
 */
const DIRS: readonly LabelAnchor[] = [
  "right",
  "top-right",
  "top",
  "top-left",
  "left",
  "bottom-left",
  "bottom",
  "bottom-right",
];

/** Base neighbor radius (~130 m) for unrelated stops, in degrees. */
const BASE_R = 0.0012;
/** Extended neighbor radius (~330 m) for same-logical-stop pairs, in degrees. */
const EXTENDED_R = 0.003;

/**
 * True when two stop names refer to the same logical stop: an exact match, or
 * names that differ only by a trailing number ("Stop 01" vs "Stop 02"). Used to
 * widen the pairing radius so the two platforms of one stop coordinate their
 * labels across a wider gap.
 */
export function sameLogicalStop(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = stripTrailingNumber(a);
  return sa === stripTrailingNumber(b) && sa.length > 0;
}

/**
 * Pairing radius (degrees) between two stops: {@link EXTENDED_R} when they are
 * the same logical stop, else {@link BASE_R}.
 */
export function pairRadius(
  a: { name: string },
  b: { name: string },
): number {
  return sameLogicalStop(a.name, b.name) ? EXTENDED_R : BASE_R;
}

interface Pt {
  name: string;
  /** `name` with a trailing number stripped — precomputed for the hot path. */
  stripped: string;
  lat: number;
  lon: number;
}

/** Strip a trailing `\s*\d+` and trim. Shared by {@link sameLogicalStop}. */
function stripTrailingNumber(s: string): string {
  return s.replace(/\s*\d+$/, "").trim();
}

/**
 * Hot-path equivalent of {@link sameLogicalStop} using precomputed stripped
 * names, avoiding a regex per pair (called O(candidates) times). Behaviour is
 * identical to the exported function.
 */
function sameLogicalPt(a: Pt, b: Pt): boolean {
  if (a.name === b.name) return true;
  return a.stripped === b.stripped && a.stripped.length > 0;
}

function pairRadiusPt(a: Pt, b: Pt): number {
  return sameLogicalPt(a, b) ? EXTENDED_R : BASE_R;
}

/**
 * Equirectangular distance in (cos-corrected) degrees. Cheap and accurate enough
 * at the <1 km scale this solver cares about.
 * deliberately degree-based (not metres) because the radius constants are tuned
 * in this space.
 */
function geoDist(a: Pt, b: Pt): number {
  const dlat = a.lat - b.lat;
  const dlon = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dlat * dlat + dlon * dlon);
}

/** Map an angle in degrees (0 = right, CCW) to a {@link DIRS} index. */
function angleToIdx(angle: number): number {
  return Math.round(((((angle % 360) + 360) % 360) / 45)) % 8;
}

// ── Spatial grid ─────────────────────────────────────────────────────────────
//
// Buckets stops so neighbor enumeration only scans a 3×3 block of cells instead
// of every other stop. The cell size is the MAX pairing radius (EXTENDED_R), and
// longitude is pre-scaled by cos(maxAbsLat) so a cell is (at least) EXTENDED_R
// wide in the same cos-corrected space `geoDist` measures. Choosing the minimum
// cos in the dataset guarantees the 3×3 block is a *superset* of every true
// neighbor (it can never miss one), which keeps the output identical to the
// brute-force prototype while remaining O(n).

interface Grid {
  /** Cell key → ascending stop indices in that cell. */
  cells: Map<number, number[]>;
  /** Per-stop lat cell coordinate. */
  cx: Int32Array;
  /** Per-stop scaled-lon cell coordinate. */
  cy: Int32Array;
  /** cos(maxAbsLat) used to scale longitude into geoDist-comparable units. */
  cosRef: number;
}

/**
 * Pack two cell coordinates into a single numeric Map key (faster than string
 * concatenation). Offsets keep both terms non-negative; the stride comfortably
 * exceeds any city-scale cell index (lat/lon → at most ±60000 cells at the
 * EXTENDED_R cell size) while staying within Number.MAX_SAFE_INTEGER.
 */
const CELL_OFFSET = 1_000_000;
const CELL_STRIDE = 4_000_000;
function cellKey(gx: number, gy: number): number {
  return (gx + CELL_OFFSET) * CELL_STRIDE + (gy + CELL_OFFSET);
}

function buildGrid(pts: Pt[]): Grid {
  let maxAbsLat = 0;
  for (const p of pts) maxAbsLat = Math.max(maxAbsLat, Math.abs(p.lat));
  const cosRef = Math.cos((maxAbsLat * Math.PI) / 180) || 1e-6;

  const cells = new Map<number, number[]>();
  const cx = new Int32Array(pts.length);
  const cy = new Int32Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const gx = Math.floor(pts[i].lat / EXTENDED_R);
    const gy = Math.floor((pts[i].lon * cosRef) / EXTENDED_R);
    cx[i] = gx;
    cy[i] = gy;
    const key = cellKey(gx, gy);
    const bucket = cells.get(key);
    // Stops are pushed in input order, so each bucket is already ascending —
    // preserving the prototype's index-order tie-breaks downstream.
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  }
  return { cells, cx, cy, cosRef };
}

/**
 * Candidate neighbor indices (ascending, excluding `i`) drawn from the 3×3 block
 * of cells around stop `i`. A superset of the true neighbors; callers apply the
 * exact distance/radius predicate themselves.
 */
function candidatesOf(grid: Grid, i: number): number[] {
  const out: number[] = [];
  const baseX = grid.cx[i];
  const baseY = grid.cy[i];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.cells.get(cellKey(baseX + dx, baseY + dy));
      if (!bucket) continue;
      for (const j of bucket) if (j !== i) out.push(j);
    }
  }
  // Cells are visited out of index order, so sort to restore the ascending
  // ordering the prototype's full-array scan produced.
  out.sort((a, b) => a - b);
  return out;
}

// ── Phase 1: repulsion-based preferred direction ─────────────────────────────
//
// Each stop's preferred label angle points away from the inverse-square-weighted
// centroid of its neighbors (closest neighbor dominates). Only consumed as the
// fallback for stops that survive Phase 2 unassigned.

function computePreferred(pts: Pt[], candidates: number[][]): number[] {
  return pts.map((s, i) => {
    let dx = 0;
    let dy = 0;
    let n = 0;
    for (const j of candidates[i]) {
      const d = geoDist(s, pts[j]);
      const R = pairRadiusPt(s, pts[j]);
      if (d > R) continue;
      const w = 1 / (d * d + 1e-8); // inverse-square: closest neighbor dominates
      dx += (s.lon - pts[j].lon) * w;
      dy += (s.lat - pts[j].lat) * w;
      n++;
    }
    if (!n) return 0; // isolated → angle 0 (right)
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  });
}

// ── Phase 2: hybrid assignment ───────────────────────────────────────────────
//
// Pure pairs (two mutually-exclusive neighbors) get strict opposite directions;
// remaining cluster members are assigned closest-pair-first, each pushed away
// from its nearest already-resolved neighbor while avoiding directions already
// taken by neighbors.

function pickBest(preferredIdx: number, taken: Set<number>): number {
  if (!taken.has(preferredIdx)) return preferredIdx;
  let bestIdx = preferredIdx;
  let bestScore = Infinity;
  for (let delta = 1; delta < 8; delta++) {
    for (const sign of [1, -1]) {
      const idx = (((preferredIdx + delta * sign) % 8) + 8) % 8;
      if (taken.has(idx)) continue;
      const score = delta;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    if (bestScore <= delta) break;
  }
  return bestIdx;
}

function hybridAssign(
  pts: Pt[],
  candidates: number[][],
  repulsionAngles: number[],
): number[] {
  const dirs: (number | null)[] = new Array(pts.length).fill(null);

  // Adaptive-radius neighbor lists (ascending index order, strict `<` predicate
  // — matching the prototype, which differs from Phase 1's inclusive `> R`).
  const neighbors = pts.map((s, i) =>
    candidates[i].filter((j) => geoDist(s, pts[j]) < pairRadiusPt(s, pts[j])),
  );

  // Pure pairs: stop with exactly one neighbor whose sole neighbor is itself.
  const isPurePair = new Array(pts.length).fill(false);
  for (let i = 0; i < pts.length; i++) {
    if (neighbors[i].length === 1) {
      const j = neighbors[i][0];
      if (neighbors[j].length === 1 && neighbors[j][0] === i) {
        isPurePair[i] = true;
        isPurePair[j] = true;
      }
    }
  }

  // Step 1: pure pairs push directly away from each other.
  for (let i = 0; i < pts.length; i++) {
    if (!isPurePair[i] || dirs[i] !== null) continue;
    const j = neighbors[i][0];
    const awayI =
      (Math.atan2(pts[i].lat - pts[j].lat, pts[i].lon - pts[j].lon) * 180) /
      Math.PI;
    const awayJ =
      (Math.atan2(pts[j].lat - pts[i].lat, pts[j].lon - pts[i].lon) * 180) /
      Math.PI;
    dirs[i] = angleToIdx(awayI);
    dirs[j] = angleToIdx(awayJ);
  }

  // Step 2: remaining cluster members, closest-pair-first.
  const edges: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (dirs[i] !== null) continue;
    for (const j of neighbors[i]) {
      if (j > i && dirs[j] === null) {
        edges.push({ i, j, d: geoDist(pts[i], pts[j]) });
      }
    }
  }
  edges.sort((a, b) => a.d - b.d);

  for (const { i, j } of edges) {
    if (dirs[i] !== null && dirs[j] !== null) continue;

    if (dirs[i] === null && dirs[j] === null) {
      const awayI =
        (Math.atan2(pts[i].lat - pts[j].lat, pts[i].lon - pts[j].lon) * 180) /
        Math.PI;
      const awayJ = ((awayI + 180) % 360) - 180;
      const idxI = angleToIdx(awayI);
      const idxJ = angleToIdx(awayJ);
      const takenI = new Set<number>();
      const takenJ = new Set<number>();
      for (const n of neighbors[i]) if (dirs[n] !== null) takenI.add(dirs[n]);
      for (const n of neighbors[j]) if (dirs[n] !== null) takenJ.add(dirs[n]);
      dirs[i] = pickBest(idxI, takenI);
      takenJ.add(dirs[i]); // i resolved; j should avoid it
      dirs[j] = pickBest(idxJ, takenJ);
    } else {
      const [resolved, unresolved] = dirs[i] !== null ? [i, j] : [j, i];
      const taken = new Set<number>();
      for (const n of neighbors[unresolved]) {
        if (dirs[n] !== null) taken.add(dirs[n]);
      }
      const awayAngle =
        (Math.atan2(
          pts[unresolved].lat - pts[resolved].lat,
          pts[unresolved].lon - pts[resolved].lon,
        ) *
          180) /
        Math.PI;
      dirs[unresolved] = pickBest(angleToIdx(awayAngle), taken);
    }
  }

  // Any remaining isolated stops fall back to their Phase-1 repulsion angle
  // (angle 0 → "right" when fully isolated).
  for (let i = 0; i < pts.length; i++) {
    if (dirs[i] === null) dirs[i] = angleToIdx(repulsionAngles[i]);
  }

  return dirs as number[];
}

/**
 * Compute one {@link LabelAnchor} per stop, keyed by `stop.id`.
 *
 * Pure and deterministic: identical input yields identical output. Stops with no
 * nearby neighbors get `"right"`. Same-name pairs (e.g. opposite platforms of a
 * stop) get opposing anchors; tight clusters spread their labels across distinct
 * directions.
 *
 * @param stops Stops to place. Input order is the only tie-break basis, so a
 *   stable input order gives a stable result.
 */
export function computeLabelAnchors(
  stops: readonly GtfsStop[],
): Map<string, LabelAnchor> {
  const result = new Map<string, LabelAnchor>();
  if (stops.length === 0) return result;

  const pts: Pt[] = stops.map((s) => ({
    name: s.name,
    stripped: stripTrailingNumber(s.name),
    lat: s.lat,
    lon: s.lon,
  }));
  const grid = buildGrid(pts);
  // Candidate neighbor lists (3×3 cell block, ascending index) computed once and
  // shared by both phases — each phase applies its own distance predicate.
  const candidates = pts.map((_, i) => candidatesOf(grid, i));
  const repulsion = computePreferred(pts, candidates);
  const dirs = hybridAssign(pts, candidates, repulsion);

  for (let i = 0; i < stops.length; i++) {
    result.set(stops[i].id, DIRS[dirs[i]]);
  }
  return result;
}
