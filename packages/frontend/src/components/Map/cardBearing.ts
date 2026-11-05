// ── Stop-card tangent / side / physical-group derivation (Stage 2) ───────────
//
// Pure, testable geometry that derives a local route tangent, a curb `side`
// (the unit normal the card should sit on), and same-name physical groups. No
// map, React, solver, or backend dependency.
//
// Coordinate frame: a *local equirectangular meters frame* centered on each
// stop. For a stop at (lat0, lon0):
//   x = (lon - lon0) * cos(lat0) * R * π/180   (east is +x)
//   y = (lat - lat0) * R * π/180               (north is +y)
//   R = 6_371_000 m
// `+y` = geographic north, `+x` = geographic east. (The screen y-flip — screen
// +y points DOWN — is NOT handled here; a later task converts this geographic
// frame to screen space.)
//

/** Earth radius in metres for the local equirectangular projection. */
const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;
const UNPARENTED_PAIR_MAX_DISTANCE_M = 150;
const SHAPE_SIDE_MIN_DISTANCE_M = 2;
const SHAPE_SIDE_MAX_DISTANCE_M = 80;
const SHAPE_SIDE_MIN_COHERENCE = 0.7;
const SIBLING_MAX_TANGENT_DOT = 0.65;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface StopHint {
  /** Unit curb normal the card should sit on, or null when undetermined. */
  side: Vec2 | null;
}

export interface PatternPolyline {
  /** Stop ids actually served by the direction/pattern owning this shape. */
  stopIds: Set<string>;
  polyline: LatLon[];
}

/**
 * Select only route-pattern shapes that actually serve `stopId`.
 *
 * A route can have opposing or branched shapes. Passing every route shape to
 * every stop mixes travel directions and makes curb-side placement depend on
 * arbitrary shape order instead of the lines serving that physical platform.
 */
export function polylinesServingStop(
  stopId: string,
  patterns: readonly PatternPolyline[],
): LatLon[][] {
  return patterns
    .filter((pattern) => pattern.stopIds.has(stopId))
    .map((pattern) => pattern.polyline);
}

interface StopLike {
  id: string;
  name: string;
  location: LatLon;
  parentStationId?: string;
}

/**
 * Project `p` into the local equirectangular metres frame centred on `origin`.
 * `+x` = east, `+y` = north.
 */
function toLocalMeters(p: LatLon, origin: LatLon): Vec2 {
  const cosLat0 = Math.cos(origin.lat * DEG_TO_RAD);
  return {
    x: (p.lon - origin.lon) * cosLat0 * EARTH_RADIUS_M * DEG_TO_RAD,
    y: (p.lat - origin.lat) * EARTH_RADIUS_M * DEG_TO_RAD,
  };
}

/** Unit vector of `v`, or `null` for a (near-)zero vector. */
function normalize(v: Vec2): Vec2 | null {
  const len = Math.hypot(v.x, v.y);
  if (len < 1e-12) return null;
  return { x: v.x / len, y: v.y / len };
}

/** Closest point from the origin to segment a→b, with endpoint clamping. */
function projectOriginToSegment(a: Vec2, b: Vec2): { distanceSq: number; point: Vec2 } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-18) {
    return { distanceSq: a.x * a.x + a.y * a.y, point: a };
  }
  // Param t of the projection of the origin onto a→b, clamped to [0,1].
  let t = -(a.x * abx + a.y * aby) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = a.x + t * abx;
  const py = a.y + t * aby;
  return { distanceSq: px * px + py * py, point: { x: px, y: py } };
}

/**
 * Find the nearest segment (across every polyline) to `stop`, projecting all
 * points into the stop-local metres frame. Returns the segment's UNIT travel
 * vector (start→end, preserving polyline / GTFS travel order), bearing, and
 * physical vector from the shape toward the stop. The latter is `null` when
 * the stop lies on the shape centreline.
 *
 * GTFS shape points are ordered by `shape_dist_traveled`, so segment order is
 * the directed travel direction — preserved here for the side tie-break.
 * Reference: https://gtfs.org/documentation/schedule/reference/#shapestxt
 */
export function nearestSegmentTangent(
  stop: LatLon,
  polylines: LatLon[][],
): { bearingRad: number; travelDir: Vec2; shapeToStop: Vec2 | null; distanceM: number } | null {
  let bestDistSq = Infinity;
  let bestDir: Vec2 | null = null;
  let bestPoint: Vec2 | null = null;

  for (const line of polylines) {
    if (line.length < 2) continue;
    // Project the polyline once into the stop-local frame.
    let prev = toLocalMeters(line[0], stop);
    for (let i = 1; i < line.length; i++) {
      const cur = toLocalMeters(line[i], stop);
      const projection = projectOriginToSegment(prev, cur);
      if (projection.distanceSq < bestDistSq) {
        const dir = normalize({ x: cur.x - prev.x, y: cur.y - prev.y });
        // A zero-length (duplicate-point) segment has no direction; skip it as
        // a candidate even though its distance may tie.
        if (dir) {
          bestDistSq = projection.distanceSq;
          bestDir = dir;
          bestPoint = projection.point;
        }
      }
      prev = cur;
    }
  }

  if (!bestDir || !bestPoint) return null;
  return {
    bearingRad: Math.atan2(bestDir.y, bestDir.x),
    travelDir: bestDir,
    shapeToStop: normalize({ x: -bestPoint.x, y: -bestPoint.y }),
    distanceM: Math.sqrt(bestDistSq),
  };
}

/**
 * Aggregate the physical side indicated by each serving shape. Shape-to-stop
 * geometry is stronger evidence than travel handedness because it distinguishes
 * two platforms served in the same direction but drawn on opposite curbs.
 * Ignore centreline noise, implausibly distant shapes, and conflicting normals.
 */
function coherentShapeSide(stop: LatLon, polylines: LatLon[][]): Vec2 | null {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const line of polylines) {
    const t = nearestSegmentTangent(stop, [line]);
    if (
      !t?.shapeToStop ||
      t.distanceM < SHAPE_SIDE_MIN_DISTANCE_M ||
      t.distanceM > SHAPE_SIDE_MAX_DISTANCE_M
    ) {
      continue;
    }
    x += t.shapeToStop.x;
    y += t.shapeToStop.y;
    count++;
  }
  if (count === 0 || Math.hypot(x, y) / count < SHAPE_SIDE_MIN_COHERENCE) return null;
  return normalize({ x, y });
}

/** Accept sibling geometry only when it crosses, rather than follows, the road. */
function siblingSide(parentVec: Vec2, travelDir: Vec2): Vec2 | null {
  const side = normalize(parentVec);
  if (!side) return null;
  const tangentDot = Math.abs(side.x * travelDir.x + side.y * travelDir.y);
  return tangentDot <= SIBLING_MAX_TANGENT_DOT ? side : null;
}

/**
 * Derive the curb side (a unit normal in the geographic +y=north frame) the
 * card should sit on. Priority tie-break:
 *   (a) `parentVec` present → the unit `parentVec` (the platform binds to its
 *       own side of the inter-platform axis; the caller passes the vector
 *       pointing AWAY from the sibling).
 *   (b) else `dirsAgree` → the right-hand normal of travel, unit
 *       `{ x: travelDir.y, y: -travelDir.x }`. All PTN cities are right-hand
 *       drive (LT/PL/GE/FR/NO), so the platform/card sits to the right of
 *       travel — the off-road curb.
 *   (c) else → `null` (the genuine two-way street with no parent; the solver
 *       then treats the stop exactly as Stage 1, no regression).
 */
export function deriveSide(opts: {
  travelDir: Vec2;
  dirsAgree: boolean;
  parentVec?: Vec2;
}): Vec2 | null {
  if (opts.parentVec) {
    return normalize(opts.parentVec);
  }
  if (opts.dirsAgree) {
    // Right-hand normal of travel.
    return normalize({ x: opts.travelDir.y, y: -opts.travelDir.x });
  }
  return null;
}

/**
 * Group same-name platforms onto a shared key: lowercase, trim, strip a
 * trailing platform/direction token (a parenthesised/bracketed suffix or a
 * trailing number), then collapse internal whitespace.
 *
 * DELIBERATE frontend port of the backend's same-name heuristic in
 * `packages/backend/src/gtfs/labelAnchors.ts` (`sameLogicalStop` /
 * `stripTrailingNumber`). The frontend cannot import backend code, so this is
 * kept behaviourally aligned by hand — no CI gate links them. It additionally
 * strips parenthesised/bracketed suffixes (e.g. "Katedra (1)") that the
 * backend's trailing-number-only rule does not, which is required for the GTFS
 * feeds whose platform tokens are parenthesised; the trailing-number behaviour
 * matches the backend exactly.
 */
export function pairKey(name: string): string {
  let s = name.toLowerCase().trim();
  // Strip a trailing parenthesised or bracketed suffix, e.g. " (1)", " [a]".
  s = s.replace(/\s*[([][^)\]]*[)\]]\s*$/, "");
  // Strip a trailing number token, e.g. " 01", "5".
  s = s.replace(/\s*\d+$/, "");
  // Collapse internal whitespace and re-trim.
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Compose {@link nearestSegmentTangent}, {@link pairKey} and {@link deriveSide}
 * over a stop set, producing a per-stop curb-side hint.
 *
 * For each stop:
 *  - `t = nearestSegmentTangent(stop.location, shapesByStopId.get(id) ?? [])`.
 *    When `t` is null (no serving shape), the stop is a Stage-1 stop:
 *    `{ side: null }`.
 *  - Only an actual two-stop physical group gets a sibling `parentVec`.
 *    Parent stations define physical groups directly; unparented
 *    stops use connected components with a 150 m same-name edge threshold.
 *    Groups of 3+ are deliberately not assigned an arbitrary sibling.
 *  - A coherent shape-to-stop normal between 2 m and 80 m is the strongest
 *    physical curb evidence. Sibling geometry is next, but only across the
 *    tangent; right-of-travel is the final fallback.
 *  - Otherwise `dirsAgree` is whether every serving segment's travel direction
 *    is within ±90° of the first (dot ≥ 0) → `deriveSide` branch (b)/(c).
 */
export function deriveStopHints(
  stops: StopLike[],
  shapesByStopId: Map<string, LatLon[][]>,
): Map<string, StopHint> {
  // First group by normalized name and parent station. Unparented same-name
  // stops still need a proximity split: otherwise two unrelated "Centras"
  // stops anywhere in the city become siblings and point cards across town.
  const semanticKeyOf = (s: StopLike) =>
    `${pairKey(s.name)}\u0000${s.parentStationId ?? "unparented"}`;
  const semanticGroups = new Map<string, StopLike[]>();
  for (const s of stops) {
    const k = semanticKeyOf(s);
    const g = semanticGroups.get(k);
    if (g) g.push(s);
    else semanticGroups.set(k, [s]);
  }

  // stop id → physical group. A declared parent_station is authoritative.
  // Without one, split into connected components using the same 150 m
  // logical-stop radius used elsewhere in the frontend. Connectivity avoids
  // splitting a large station into accidental two-stop pairs merely because
  // its platforms form a chain wider than 150 m end-to-end.
  const physicalGroupByStopId = new Map<string, StopLike[]>();
  for (const group of semanticGroups.values()) {
    if (group[0]?.parentStationId) {
      for (const stop of group) physicalGroupByStopId.set(stop.id, group);
      continue;
    }
    const assigned = new Set<string>();
    for (const seed of group) {
      if (assigned.has(seed.id)) continue;
      const cluster: StopLike[] = [];
      const queue = [seed];
      assigned.add(seed.id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        cluster.push(current);
        for (const candidate of group) {
          if (assigned.has(candidate.id)) continue;
          const local = toLocalMeters(candidate.location, current.location);
          if (Math.hypot(local.x, local.y) > UNPARENTED_PAIR_MAX_DISTANCE_M) continue;
          assigned.add(candidate.id);
          queue.push(candidate);
        }
      }
      for (const member of cluster) {
        physicalGroupByStopId.set(member.id, cluster);
      }
    }
  }

  const out = new Map<string, StopHint>();
  for (const stop of stops) {
    const group = physicalGroupByStopId.get(stop.id) ?? [stop];
    const isPair = group.length === 2;
    const t = nearestSegmentTangent(stop.location, shapesByStopId.get(stop.id) ?? []);
    if (!t) {
      out.set(stop.id, { side: null });
      continue;
    }

    // Only a genuine two-platform group can contribute sibling geometry. Larger
    // stations are not pairs: choosing an arbitrary sibling creates long,
    // unstable connector lines around interchanges.
    const sibling = isPair ? group.find((s) => s.id !== stop.id) : undefined;

    const lines = shapesByStopId.get(stop.id) ?? [];
    const dirsAgree = servingDirsAgree(stop.location, lines);
    const shapeSide = coherentShapeSide(stop.location, lines);

    let side: Vec2 | null = shapeSide;
    if (!side && sibling) {
      // parentVec points FROM the sibling TO this stop, in this stop's frame.
      const siblingLocal = toLocalMeters(sibling.location, stop.location);
      const parentVec = { x: -siblingLocal.x, y: -siblingLocal.y };
      side = deriveSide({
        travelDir: t.travelDir,
        dirsAgree,
        parentVec: siblingSide(parentVec, t.travelDir) ?? undefined,
      });
    } else if (!side) {
      side = deriveSide({ travelDir: t.travelDir, dirsAgree });
    }

    out.set(stop.id, { side });
  }

  return out;
}

/**
 * True when every serving polyline's nearest-segment travel direction is within
 * ±90° of the first one's (dot ≥ 0). A single serving polyline trivially
 * agrees. Used by {@link deriveStopHints} to choose the RHD right-hand side.
 */
function servingDirsAgree(stop: LatLon, polylines: LatLon[][]): boolean {
  const dirs: Vec2[] = [];
  for (const line of polylines) {
    const t = nearestSegmentTangent(stop, [line]);
    if (t) dirs.push(t.travelDir);
  }
  if (dirs.length === 0) return false;
  const first = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    if (first.x * dirs[i].x + first.y * dirs[i].y < 0) return false;
  }
  return true;
}
