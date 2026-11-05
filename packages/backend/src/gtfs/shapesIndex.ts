import type { GtfsShapePoint, GtfsTrip } from "./parser.js";
import type { LatLonTuple, RoutingBundleShape } from "@pt/shared";

export interface ShapesCaps {
  shapesCount: number;
  pointsPerShape: number;
  shapesEncodedBytes: number;
}

export interface BuildShapesIndexInput {
  shapePoints: GtfsShapePoint[];
  trips: GtfsTrip[];
  caps: ShapesCaps;
  /**
   * Pre-computed shapeId → trip-reference-count map. When supplied (the PTB
   * sidecar path, which has no per-trip `shape_id` to count) it replaces the
   * count derived from `trips`, so orphan-filtering, cap-eviction order, and
   * output ordering match the Node path exactly. Entries with count 0 (or
   * shapes absent from the map) are treated as orphans and dropped.
   */
  tripShapeRefs?: Map<string, number>;
}

export interface BuildShapesIndexResult {
  shapes: RoutingBundleShape[];
  droppedCount: number;
}

function encodePolyline(coords: LatLonTuple[]): string {
  let out = "";
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of coords) {
    const e5Lat = Math.round(lat * 1e5);
    const e5Lon = Math.round(lon * 1e5);
    out += encodeSigned(e5Lat - prevLat);
    out += encodeSigned(e5Lon - prevLon);
    prevLat = e5Lat;
    prevLon = e5Lon;
  }
  return out;
}

function encodeSigned(n: number): string {
  let v = n < 0 ? ~(n << 1) : n << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function buildShapesIndex(input: BuildShapesIndexInput): BuildShapesIndexResult {
  const { shapePoints, trips, caps, tripShapeRefs } = input;
  let droppedCount = 0;

  const refs = new Map<string, number>();
  if (tripShapeRefs) {
    // PTB path: counts come from the sidecar (producer tallied trips.txt). Skip
    // zero-ref shapes so they orphan-filter identically to the Node branch.
    for (const [shapeId, count] of tripShapeRefs) {
      if (count > 0) refs.set(shapeId, count);
    }
  } else {
    for (const t of trips) {
      if (t.shapeId) refs.set(t.shapeId, (refs.get(t.shapeId) ?? 0) + 1);
    }
  }

  const grouped = new Map<string, GtfsShapePoint[]>();
  for (const p of shapePoints) {
    if (!refs.has(p.shapeId)) continue;
    let arr = grouped.get(p.shapeId);
    if (!arr) { arr = []; grouped.set(p.shapeId, arr); }
    arr.push(p);
  }
  for (const arr of grouped.values()) arr.sort((a, b) => a.sequence - b.sequence);

  for (const [shapeId, arr] of grouped) {
    if (arr.length > caps.pointsPerShape) {
      grouped.delete(shapeId);
      droppedCount++;
    }
  }

  const candidates: Array<{ shape: RoutingBundleShape; refs: number }> = [];
  for (const [shapeId, arr] of grouped) {
    const encoded = encodePolyline(arr.map((p) => [p.lat, p.lon] as LatLonTuple));
    candidates.push({
      shape: { shapeId, encodedPolyline: encoded, source: "gtfs" },
      refs: refs.get(shapeId) ?? 0,
    });
  }

  candidates.sort((a, b) => {
    if (a.refs !== b.refs) return b.refs - a.refs;
    return a.shape.shapeId < b.shape.shapeId ? -1 : 1;
  });

  while (candidates.length > caps.shapesCount) {
    candidates.pop();
    droppedCount++;
  }

  const byteLen = (s: string) => Buffer.byteLength(s, "utf8");
  let totalBytes = candidates.reduce((acc, c) => acc + byteLen(c.shape.encodedPolyline), 0);
  while (totalBytes > caps.shapesEncodedBytes && candidates.length > 0) {
    const last = candidates.pop()!;
    totalBytes -= byteLen(last.shape.encodedPolyline);
    droppedCount++;
  }

  if (droppedCount > 0) {
    console.info(`[shapesIndex] dropped ${droppedCount} shape(s) over caps`);
  }
  return { shapes: candidates.map((c) => c.shape), droppedCount };
}
