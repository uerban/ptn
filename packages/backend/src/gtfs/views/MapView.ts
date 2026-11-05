import type { CanonicalStore } from "../canonical/CanonicalStore.js";
import type { GtfsStop } from "../parser.js";

export interface MapViewBuildInput {
  canonical: CanonicalStore;
  stopRouteTripCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  minTripsPerRoute?: number;
  cellSizeDegrees?: number;
}

export interface Bbox {
  minLat: number; minLon: number; maxLat: number; maxLon: number;
}

export interface MapView {
  getActiveRoutesForStop(stopId: string): string[];
  getTripCount(stopId: string, routeId: string): number;
  getStopRouteTripCounts(): ReadonlyMap<string, ReadonlyMap<string, number>>;
  stopsInBbox(bbox: Bbox): string[];
  stopRouteEntries(): IterableIterator<readonly [string, readonly string[]]>;
  readonly stopCount: number;
}

export function buildMapView(input: MapViewBuildInput): MapView {
  const { canonical } = input;
  const minTrips = input.minTripsPerRoute ?? 0;
  const cellSize = input.cellSizeDegrees ?? 0.005;

  // stop → filtered routes
  const stopToRoutes = new Map<string, string[]>();
  for (const [stopId, routeCounts] of input.stopRouteTripCounts) {
    const routes: string[] = [];
    for (const [routeId, count] of routeCounts) {
      if (count >= minTrips) routes.push(routeId);
    }
    if (routes.length > 0) stopToRoutes.set(stopId, routes);
  }

  // Spatial grid
  const grid = new Map<string, string[]>();
  function cellKey(lat: number, lon: number): string {
    const cy = Math.floor(lat / cellSize);
    const cx = Math.floor(lon / cellSize);
    return `${cy}_${cx}`;
  }
  canonical.iterStops((stopId, stop) => {
    const key = cellKey(stop.lat, stop.lon);
    const bucket = grid.get(key);
    if (bucket) bucket.push(stopId);
    else grid.set(key, [stopId]);
  });

  return {
    get stopCount(): number { return canonical.stopCount; },
    getActiveRoutesForStop(stopId: string): string[] {
      return stopToRoutes.get(stopId) ?? [];
    },
    getTripCount(stopId: string, routeId: string): number {
      return input.stopRouteTripCounts.get(stopId)?.get(routeId) ?? 0;
    },
    getStopRouteTripCounts(): ReadonlyMap<string, ReadonlyMap<string, number>> {
      return input.stopRouteTripCounts;
    },
    stopsInBbox(bbox: Bbox): string[] {
      const minCy = Math.floor(bbox.minLat / cellSize);
      const maxCy = Math.floor(bbox.maxLat / cellSize);
      const minCx = Math.floor(bbox.minLon / cellSize);
      const maxCx = Math.floor(bbox.maxLon / cellSize);
      const result: string[] = [];
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const bucket = grid.get(`${cy}_${cx}`);
          if (!bucket) continue;
          for (const stopId of bucket) {
            const s = canonical.getStop(stopId);
            if (!s) continue;
            if (s.lat >= bbox.minLat && s.lat <= bbox.maxLat &&
                s.lon >= bbox.minLon && s.lon <= bbox.maxLon) {
              result.push(stopId);
            }
          }
        }
      }
      return result;
    },
    stopRouteEntries(): IterableIterator<readonly [string, readonly string[]]> {
      return (function* () {
        for (const entry of stopToRoutes) yield entry as readonly [string, readonly string[]];
      })();
    },
  };
}
