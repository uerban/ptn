import type { LatLon } from "@pt/shared";

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Haversine distance between two points in meters */
export function haversineDistance(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Initial bearing from point a to point b in degrees (0-360) */
export function bearing(from: LatLon, to: LatLon): number {
  const dLon = toRad(to.lon - from.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const b = toDeg(Math.atan2(y, x));
  return (b + 360) % 360;
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type CardinalDirection = (typeof CARDINALS)[number];

/** Convert degrees (0-360) to 8-point cardinal direction */
export function cardinalDirection(degrees: number): CardinalDirection {
  const index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
  return CARDINALS[index];
}

/**
 * Project point p onto the line segment a-b and return the nearest point.
 * Uses simple equirectangular approximation (fine for short distances).
 */
export function nearestPointOnSegment(
  p: LatLon,
  a: LatLon,
  b: LatLon
): LatLon {
  // Apply cos(lat) scaling to longitude so east-west distances are
  // weighted correctly at high latitudes (e.g. Gdansk at 54 deg N).
  const cosLat = Math.cos(toRad((a.lat + b.lat) / 2));
  const dxScaled = (b.lon - a.lon) * cosLat;
  const dy = b.lat - a.lat;
  if (dxScaled === 0 && dy === 0) return a;

  const pxScaled = (p.lon - a.lon) * cosLat;
  let t = (pxScaled * dxScaled + (p.lat - a.lat) * dy) / (dxScaled * dxScaled + dy * dy);
  t = Math.max(0, Math.min(1, t));

  return {
    lat: a.lat + t * dy,
    lon: a.lon + t * (b.lon - a.lon),
  };
}

/**
 * Calculate progress (0-1) of position along a polyline.
 * Finds the nearest segment, then returns cumulative distance to the
 * projection point divided by total line length.
 */
export function progressAlongLine(pos: LatLon, line: LatLon[]): number {
  if (line.length < 2) return 0;

  let bestDist = Infinity;
  let bestSegIdx = 0;
  let bestProjection: LatLon = line[0];

  for (let i = 0; i < line.length - 1; i++) {
    const proj = nearestPointOnSegment(pos, line[i], line[i + 1]);
    const d = haversineDistance(pos, proj);
    if (d < bestDist) {
      bestDist = d;
      bestSegIdx = i;
      bestProjection = proj;
    }
  }

  // Sum distance of segments before the best segment
  let distBefore = 0;
  for (let i = 0; i < bestSegIdx; i++) {
    distBefore += haversineDistance(line[i], line[i + 1]);
  }

  // Add distance from segment start to projection
  distBefore += haversineDistance(line[bestSegIdx], bestProjection);

  // Total line length
  let totalLength = 0;
  for (let i = 0; i < line.length - 1; i++) {
    totalLength += haversineDistance(line[i], line[i + 1]);
  }

  if (totalLength === 0) return 0;
  return Math.max(0, Math.min(1, distBefore / totalLength));
}
