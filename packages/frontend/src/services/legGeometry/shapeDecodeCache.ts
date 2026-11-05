import type { LonLat } from "@pt/shared";
import { decodePolyline } from "../../utils/polyline";

const MAX_ENTRIES = 1024;
const cache = new Map<string, LonLat[]>();

export function decodeShape(shapeId: string, encoded: string): LonLat[] {
  const hit = cache.get(shapeId);
  if (hit) {
    cache.delete(shapeId);
    cache.set(shapeId, hit);
    return hit;
  }
  const decoded: LonLat[] = decodePolyline(encoded).map(
    (p) => [p.lon, p.lat] as LonLat,
  );
  cache.set(shapeId, decoded);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return decoded;
}

export function clearShapeDecodeCache(): void {
  cache.clear();
}

export function __shapeDecodeCacheSize(): number {
  return cache.size;
}
