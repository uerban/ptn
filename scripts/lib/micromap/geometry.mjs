// Geometry helpers for the micromap builder.
//
// Everything here works on GeoJSON-order coordinate pairs — `[lon, lat]` in
// degrees — because that is what `osmium export -f geojsonseq` hands us and
// what MapLibre consumes on the other end. Distances are computed on a local
// equirectangular projection: at city scale (tens of km) the error against a
// proper geodesic is well under a metre, and every threshold in the builder is
// a coarse "is this feature worth a pixel" judgement anyway.

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

/** Metres per degree of latitude — constant enough at city scale. */
export function metersPerDegreeLat() {
  return (EARTH_RADIUS_M * DEG_TO_RAD);
}

/** Metres per degree of longitude at the given latitude. */
export function metersPerDegreeLon(lat) {
  return metersPerDegreeLat() * Math.cos(lat * DEG_TO_RAD);
}

/**
 * Project `[lon, lat]` into local metres around `originLat`. Only differences
 * between projected points are meaningful — this is not a map projection.
 */
export function toLocalMeters([lon, lat], originLat) {
  return [lon * metersPerDegreeLon(originLat), lat * metersPerDegreeLat()];
}

export function distanceMeters(a, b, originLat = a[1]) {
  const [ax, ay] = toLocalMeters(a, originLat);
  const [bx, by] = toLocalMeters(b, originLat);
  return Math.hypot(ax - bx, ay - by);
}

/** Total length of a `[lon, lat]` polyline, in metres. */
export function lineLengthMeters(points) {
  if (points.length < 2) return 0;
  const originLat = points[0][1];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(points[i - 1], points[i], originLat);
  }
  return total;
}

/**
 * Unsigned area of a `[lon, lat]` ring, in square metres (shoelace on the
 * local projection). Rings are assumed simple, which OSM-assembled areas are.
 */
export function ringAreaMeters(ring) {
  if (ring.length < 4) return 0;
  const originLat = ring[0][1];
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = toLocalMeters(ring[i], originLat);
    const [x2, y2] = toLocalMeters(ring[i + 1], originLat);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function perpendicularDistanceMeters(point, lineStart, lineEnd, originLat) {
  const [px, py] = toLocalMeters(point, originLat);
  const [ax, ay] = toLocalMeters(lineStart, originLat);
  const [bx, by] = toLocalMeters(lineEnd, originLat);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  // Distance to the infinite line, not the segment: Douglas-Peucker keeps the
  // endpoints, so the perpendicular is the right measure of "how much shape
  // would we lose by dropping this vertex".
  return Math.abs(dy * px - dx * py + bx * ay - by * ax) / Math.sqrt(lengthSq);
}

/**
 * Douglas-Peucker simplification with a tolerance in metres. Iterative (an
 * explicit stack) so a pathological coastline can't blow the call stack.
 */
export function simplifyLine(points, toleranceMeters) {
  if (points.length <= 2 || toleranceMeters <= 0) return points;
  const originLat = points[0][1];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;
    let maxDistance = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularDistanceMeters(
        points[i],
        points[first],
        points[last],
        originLat,
      );
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (maxDistance > toleranceMeters && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplify a closed ring while keeping it closed and still a ring. A ring that
 * simplifies below four points (three distinct corners plus the repeat) has no
 * area left to draw, so the caller should drop it — signalled by `null`.
 */
export function simplifyRing(ring, toleranceMeters) {
  if (ring.length < 4) return null;
  const simplified = simplifyLine(ring, toleranceMeters);
  if (simplified.length < 4) return null;
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) simplified.push(first);
  return simplified.length >= 4 ? simplified : null;
}
