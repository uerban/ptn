import type { TransportMode } from "@pt/shared";
import { decodePolyline } from "../../utils/polyline.ts";

export const GTFS_CORRIDOR_SOURCE = "gtfs-corridors-source";
export const GTFS_CORRIDOR_LAYER = "gtfs-corridors-line";

export const MAX_LOCAL_CORRIDOR_FEATURES = 1_200;

export interface CorridorShapeInput {
  shapeId: string;
  encodedPolyline?: string;
  points?: readonly { lat: number; lon: number }[];
}

export interface CorridorTripInput {
  tripId: string;
  routeId: string;
  shapeId?: string;
}

export interface CorridorStopInput {
  id: string;
  lat: number;
  lon: number;
}

export interface CorridorRoutePatternInput {
  stopIds: readonly string[];
}

export interface CorridorRouteInput {
  id: string;
  mode: TransportMode;
  stopIds?: readonly string[];
  directionPatterns?: readonly CorridorRoutePatternInput[];
}

export interface GtfsCorridorProperties {
  id: string;
  mode: TransportMode | "UNKNOWN";
  routeCount: number;
  shapeCount: number;
  tripCount: number;
  importance: number;
}

export type GtfsCorridorFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  GtfsCorridorProperties
>;

interface CorridorBucket {
  readonly key: string;
  readonly shape?: CorridorShapeInput;
  readonly coordinates?: [number, number][];
  readonly shapeIds: Set<string>;
  readonly routeIds: Set<string>;
  readonly modeCounts: Map<TransportMode, number>;
  tripCount: number;
}

export const EMPTY_GTFS_CORRIDORS: GtfsCorridorFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function dominantMode(
  modeCounts: ReadonlyMap<TransportMode, number>,
): TransportMode | "UNKNOWN" {
  let best: TransportMode | "UNKNOWN" = "UNKNOWN";
  let bestCount = 0;
  for (const [mode, count] of modeCounts) {
    if (
      count > bestCount ||
      (count === bestCount && (best === "UNKNOWN" || mode < best))
    ) {
      best = mode;
      bestCount = count;
    }
  }
  return best;
}

function importanceFor(tripCount: number): number {
  return Math.min(6, Math.max(1, Math.ceil(Math.log2(tripCount + 1))));
}

function bucketSortKey(bucket: CorridorBucket): string {
  const shapeId = [...bucket.shapeIds].sort()[0];
  if (shapeId) return `shape:${shapeId}`;
  const routeId = [...bucket.routeIds].sort()[0];
  return routeId ? `route:${routeId}:${bucket.key}` : bucket.key;
}

function decodeCorridorLine(encodedPolyline: string): [number, number][] {
  try {
    return decodePolyline(encodedPolyline)
      .map((p) => [p.lon, p.lat] as [number, number])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  } catch {
    return [];
  }
}

function coordinatesFromPoints(
  points: readonly { lat: number; lon: number }[] | undefined,
): [number, number][] {
  return (points ?? [])
    .map((p) => [p.lon, p.lat] as [number, number])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function corridorKey(shape: CorridorShapeInput): string | null {
  const encoded = shape.encodedPolyline?.trim();
  if (encoded && encoded.length >= 2) return `polyline:${encoded}`;

  const coordinates = coordinatesFromPoints(shape.points);
  return corridorKeyFromCoordinates(coordinates);
}

function corridorKeyFromCoordinates(coordinates: readonly [number, number][]): string | null {
  if (coordinates.length < 2) return null;
  return `points:${coordinates.map(([lon, lat]) => `${lon},${lat}`).join(";")}`;
}

function corridorCoordinates(shape: CorridorShapeInput): [number, number][] {
  const encoded = shape.encodedPolyline?.trim();
  if (encoded && encoded.length >= 2) return decodeCorridorLine(encoded);
  return coordinatesFromPoints(shape.points);
}

function coordinatesFromStopIds(
  stopIds: readonly string[],
  stopById: ReadonlyMap<string, CorridorStopInput>,
): [number, number][] {
  const coordinates: [number, number][] = [];
  for (const stopId of stopIds) {
    const stop = stopById.get(stopId);
    if (!stop) continue;
    const coord: [number, number] = [stop.lon, stop.lat];
    if (Number.isFinite(coord[0]) && Number.isFinite(coord[1])) {
      coordinates.push(coord);
    }
  }
  return coordinates;
}

function routeStopSequences(route: CorridorRouteInput): readonly (readonly string[])[] {
  const patterns = route.directionPatterns
    ?.map((pattern) => pattern.stopIds)
    .filter((stopIds) => stopIds.length >= 2);
  if (patterns && patterns.length > 0) return patterns;
  return route.stopIds && route.stopIds.length >= 2 ? [route.stopIds] : [];
}

export function buildGtfsCorridorFeatureCollection({
  shapes,
  trips,
  routes,
  stops = [],
  maxFeatures = MAX_LOCAL_CORRIDOR_FEATURES,
}: {
  shapes: readonly CorridorShapeInput[];
  trips: readonly CorridorTripInput[];
  routes: readonly CorridorRouteInput[];
  stops?: readonly CorridorStopInput[];
  maxFeatures?: number;
}): GtfsCorridorFeatureCollection {
  if (maxFeatures <= 0) return EMPTY_GTFS_CORRIDORS;

  const shapeById = new Map(
    shapes.map((shape) => [shape.shapeId, shape]),
  );
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const tripCountByRoute = new Map<string, number>();
  const routeIdsWithShapeCorridors = new Set<string>();
  const byPolyline = new Map<string, CorridorBucket>();

  const upsertBucket = ({
    key,
    shape,
    coordinates,
    shapeId,
    routeId,
    mode,
    tripCount,
  }: {
    key: string;
    shape?: CorridorShapeInput;
    coordinates?: [number, number][];
    shapeId?: string;
    routeId: string;
    mode?: TransportMode;
    tripCount: number;
  }) => {
    let bucket = byPolyline.get(key);
    if (!bucket) {
      bucket = {
        key,
        shape,
        coordinates,
        shapeIds: new Set(),
        routeIds: new Set(),
        modeCounts: new Map(),
        tripCount: 0,
      };
      byPolyline.set(key, bucket);
    }

    if (shapeId) bucket.shapeIds.add(shapeId);
    bucket.routeIds.add(routeId);
    bucket.tripCount += tripCount;

    if (mode) {
      bucket.modeCounts.set(
        mode,
        (bucket.modeCounts.get(mode) ?? 0) + tripCount,
      );
    }
  };

  for (const trip of trips) {
    tripCountByRoute.set(
      trip.routeId,
      (tripCountByRoute.get(trip.routeId) ?? 0) + 1,
    );
    if (!trip.shapeId) continue;
    const shape = shapeById.get(trip.shapeId);
    if (!shape) continue;
    const key = corridorKey(shape);
    if (!key) continue;

    const route = routeById.get(trip.routeId);
    upsertBucket({
      key,
      shape,
      shapeId: shape.shapeId,
      routeId: trip.routeId,
      mode: route?.mode,
      tripCount: 1,
    });
    routeIdsWithShapeCorridors.add(trip.routeId);
  }

  /**
   * Fallback for local/GTFS-only maps when the optional GTFS shapes artifact is
   * absent, stale, or skipped for quota. GTFS stop_times.txt permits repeated
   * stops in one trip for loop/lasso routes, so the stopId sequence is kept as
   * ordered data instead of collapsed to a set.
   * Reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
   */
  for (const route of routes) {
    if (routeIdsWithShapeCorridors.has(route.id)) continue;
    const tripCount = Math.max(1, tripCountByRoute.get(route.id) ?? 0);
    for (const stopIds of routeStopSequences(route)) {
      const coordinates = coordinatesFromStopIds(stopIds, stopById);
      const key = corridorKeyFromCoordinates(coordinates);
      if (!key) continue;
      upsertBucket({
        key,
        coordinates,
        routeId: route.id,
        mode: route.mode,
        tripCount,
      });
    }
  }

  const buckets = [...byPolyline.values()]
    .sort((a, b) => {
      const byTrips = b.tripCount - a.tripCount;
      if (byTrips !== 0) return byTrips;
      const byRoutes = b.routeIds.size - a.routeIds.size;
      if (byRoutes !== 0) return byRoutes;
      return bucketSortKey(a).localeCompare(bucketSortKey(b));
    })
    .slice(0, maxFeatures);

  const features: GtfsCorridorFeatureCollection["features"] = [];
  for (const bucket of buckets) {
    const coordinates = bucket.shape
      ? corridorCoordinates(bucket.shape)
      : (bucket.coordinates ?? []);
    if (coordinates.length < 2) continue;

    const id =
      [...bucket.shapeIds].sort()[0] ??
      `stopseq:${[...bucket.routeIds].sort()[0] ?? bucket.key}`;
    features.push({
      type: "Feature",
      id,
      geometry: {
        type: "LineString",
        coordinates,
      },
      properties: {
        id,
        mode: dominantMode(bucket.modeCounts),
        routeCount: bucket.routeIds.size,
        shapeCount: bucket.shapeIds.size,
        tripCount: bucket.tripCount,
        importance: importanceFor(bucket.tripCount),
      },
    });
  }

  return { type: "FeatureCollection", features };
}
