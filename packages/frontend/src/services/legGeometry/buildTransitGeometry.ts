import type { LatLon, LegGeometryResult, LonLat, RaptorLeg } from "@pt/shared";
import { decodeShape } from "./shapeDecodeCache.ts";

// Squared-degree threshold for snap-to-shape sanity. ~50 km in
// equirectangular (50/111.32)² ≈ 0.2. Real-world stops are typically
// within tens-to-hundreds of meters of their route polyline; a >50km
// nearest-vertex distance reliably indicates the shape doesn't match
// the leg (e.g., feed-shape mismatch, wrong-city stop data) and the
// snap should be rejected rather than producing wrong-shape geometry.
const MAX_SNAP_DIST_SQ = 0.2;

/**
 * Return the index of the shape vertex closest to `loc` within
 * `MAX_SNAP_DIST_SQ`, or `-1` if no vertex is close enough. Searches
 * `coords[startIdx..]` so callers can constrain alight to be at or
 * after board.
 *
 * Exported as `__findNearestShapeIdxForTests` for unit coverage of
 * the threshold contract; production code should call via
 * `sliceShapeForLeg`.
 */
function nearestShapeIdx(coords: LonLat[], loc: LatLon, startIdx = 0): number {
  const cosLat = Math.cos((loc.lat * Math.PI) / 180);
  let best = -1;
  let bestDist = Infinity;
  for (let i = startIdx; i < coords.length; i++) {
    const dLon = (coords[i][0] - loc.lon) * cosLat;
    const dLat = coords[i][1] - loc.lat;
    const d = dLon * dLon + dLat * dLat;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return bestDist <= MAX_SNAP_DIST_SQ ? best : -1;
}

export const __findNearestShapeIdxForTests = nearestShapeIdx;

function sliceShapeForLeg(coords: LonLat[], board: LatLon, alight: LatLon): LonLat[] {
  const boardIdx = nearestShapeIdx(coords, board);
  if (boardIdx < 0) return [];
  const alightIdx = nearestShapeIdx(coords, alight, boardIdx);
  if (alightIdx < 0) return [];
  return coords.slice(boardIdx, alightIdx + 1);
}

interface RouteLike { id: string; stopIds: string[] }
interface TripLike { shapeId?: string }
interface ShapeLike { shapeId: string; encodedPolyline: string; source: "gtfs" }
interface StopLike { id: string; lat: number; lon: number }

export interface BuildTransitGeometryLegInput {
  kind: "leg";
  leg: RaptorLeg;
  route?: RouteLike;
  trip?: TripLike;
  shape?: ShapeLike;
  stops?: Array<StopLike | undefined>;
  fromLocation?: LatLon;
  toLocation?: LatLon;
}

export interface BuildTransitGeometryExplicitInput {
  kind: "stopIds";
  explicitStopIds: string[];
  stops?: Array<StopLike | undefined>;
  shape?: ShapeLike;
  fromLocation: LatLon;
  toLocation: LatLon;
}

type Input = BuildTransitGeometryLegInput | BuildTransitGeometryExplicitInput;

const warnedLegs = new Set<string>();
const warnedShapes = new Set<string>();

export function buildTransitGeometry(input: Input): LegGeometryResult {
  // 1. Shape tier.
  if (input.shape) {
    const encoded = input.shape.encodedPolyline;
    const trimmed = typeof encoded === "string" ? encoded.trim() : "";
    if (trimmed.length < 2) {
      if (!warnedShapes.has(input.shape.shapeId)) {
        warnedShapes.add(input.shape.shapeId);
        console.error(`[legGeometry] malformed polyline for shape ${input.shape.shapeId}`);
      }
    } else {
      try {
        const coords = decodeShape(input.shape.shapeId, encoded);
        const valid = coords.every(
          ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat),
        );
        const fromLoc = input.kind === "leg" ? input.fromLocation : undefined;
        const toLoc = input.kind === "leg" ? input.toLocation : undefined;
        const sliced = fromLoc && toLoc
          ? sliceShapeForLeg(coords, fromLoc, toLoc)
          : coords;
        if (valid && coords.length >= 2) {
          if (sliced.length >= 2) {
            return { coords: sliced, source: "shape", partial: false, pending: false };
          }
          if (!warnedShapes.has(input.shape.shapeId)) {
            warnedShapes.add(input.shape.shapeId);
            console.warn(
              `[legGeometry] shape slice degenerate for ${input.shape.shapeId}, falling through`,
              { fromLocation: fromLoc, toLocation: toLoc },
            );
          }
        } else if (!warnedShapes.has(input.shape.shapeId)) {
          warnedShapes.add(input.shape.shapeId);
          console.error(`[legGeometry] malformed polyline for shape ${input.shape.shapeId}`);
        }
      } catch (err) {
        if (!warnedShapes.has(input.shape.shapeId)) {
          warnedShapes.add(input.shape.shapeId);
          console.error(`[legGeometry] failed to decode shape ${input.shape.shapeId}`, err);
        }
      }
    }
  }

  // 2. Intermediate tier.
  let slice: Array<StopLike | undefined> | undefined;
  let sliceLen = 0;
  let endpoints: [LatLon, LatLon] | undefined;

  if (input.kind === "stopIds") {
    slice = input.stops;
    sliceLen = input.explicitStopIds.length;
    endpoints = [input.fromLocation, input.toLocation];
  } else {
    const { leg, route, stops, fromLocation, toLocation } = input;
    endpoints = fromLocation && toLocation ? [fromLocation, toLocation] : undefined;
    if (leg.type === "transit") {
      if (leg.boardStopIdx > leg.alightStopIdx) {
        if (!warnedLegs.has(leg.tripId)) {
          warnedLegs.add(leg.tripId);
          console.warn(`[legGeometry] boardStopIdx > alightStopIdx on leg`, leg);
        }
        return {
          coords: endpoints
            ? [[endpoints[0].lon, endpoints[0].lat], [endpoints[1].lon, endpoints[1].lat]]
            : [],
          source: "endpoints", partial: false, pending: false,
        };
      }
      if (route) {
        slice = stops;
        sliceLen = leg.alightStopIdx - leg.boardStopIdx + 1;
      }
    }
  }

  if (slice && sliceLen > 0) {
    const resolved = slice.filter((s): s is StopLike => !!s);
    const threshold = Math.max(3, Math.ceil(0.8 * sliceLen));
    if (resolved.length >= threshold) {
      return {
        coords: resolved.map((s) => [s.lon, s.lat] as LonLat),
        source: "intermediate",
        partial: resolved.length < sliceLen,
        pending: false,
      };
    }
  }

  // 3. Endpoints tier.
  if (endpoints) {
    return {
      coords: [[endpoints[0].lon, endpoints[0].lat], [endpoints[1].lon, endpoints[1].lat]],
      source: "endpoints", partial: false, pending: false,
    };
  }
  return { coords: [], source: "endpoints", partial: false, pending: false };
}

export function __resetWarnedSets(): void {
  warnedLegs.clear();
  warnedShapes.clear();
}
