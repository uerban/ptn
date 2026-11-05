import type { ExpressionSpecification } from "maplibre-gl";
import type { GbfsStation } from "../../services/gbfs/types.ts";

/**
 * Pure GeoJSON feature-builder for the bike-share layer.
 *
 * Kept free of MapLibre so the bucket/label logic is unit-testable; the
 * rendering half lives in `BikeShareLayer.tsx`.
 */

/** MapLibre source/layer ids owned by `BikeShareLayer`. */
export const BIKE_SOURCE = "bike-share-source";
export const BIKE_CIRCLE_LAYER = "bike-share-circles";
export const BIKE_LABEL_LAYER = "bike-share-labels";

/** Marker color bucket, strict top-down precedence (see {@link bucketFor}). */
export type BikeShareBucket = "grey" | "green" | "amber" | "red";

export const BUCKET_COLORS: Record<BikeShareBucket, string> = {
  /** Status unknown / not installed / not renting. */
  grey: "#9ca3af",
  /** Plenty of bikes (>= 3). */
  green: "#16a34a",
  /** Running low (1-2). */
  amber: "#f59e0b",
  /** Empty (0). */
  red: "#dc2626",
};

/**
 * Data-driven `circle-color` expression matching on the per-feature
 * `bucket` property; grey doubles as the match fallback.
 */
export const BIKE_CIRCLE_COLOR: ExpressionSpecification = [
  "match",
  ["get", "bucket"],
  "green",
  BUCKET_COLORS.green,
  "amber",
  BUCKET_COLORS.amber,
  "red",
  BUCKET_COLORS.red,
  BUCKET_COLORS.grey,
];

/**
 * Count-label color with WCAG AA contrast against the opaque bucket colors:
 * white on red (4.83:1), dark ink on green/amber/grey (>= 5.38:1).
 */
export const BIKE_LABEL_COLOR: ExpressionSpecification = [
  "match",
  ["get", "bucket"],
  "red",
  "#ffffff",
  "#111827",
];

/**
 * Color bucket for one station. Precedence is strict top-down: the grey
 * conditions (null counts / `!isInstalled` / `!isRenting`) are evaluated
 * BEFORE the count tiers — a non-renting station with `bikesAvailable >= 3`
 * buckets grey, never green. `bikesAvailable === null` means status unknown
 * (offline-cached positions or absent from station_status).
 */
export function bucketFor(station: GbfsStation): BikeShareBucket {
  if (
    station.bikesAvailable === null ||
    !station.isInstalled ||
    !station.isRenting
  ) {
    return "grey";
  }
  if (station.bikesAvailable >= 3) return "green";
  if (station.bikesAvailable >= 1) return "amber";
  return "red";
}

export interface BikeShareFeatureProperties {
  /** For tap lookup back into `bikeShareStore.stations`. */
  readonly stationId: string;
  readonly name: string;
  readonly bucket: BikeShareBucket;
  /**
   * Count printed by the symbol layer. `""` when `bikesAvailable` is null —
   * unknown is never rendered as `0`; an empty text-field draws nothing.
   */
  readonly label: string;
}

/**
 * Store stations → GeoJSON FeatureCollection for the MapLibre source.
 * Feature `id` and `properties.stationId` both carry the station id so tap
 * handling can resolve the station from either.
 */
export function stationsToFeatures(
  stations: readonly GbfsStation[],
): GeoJSON.FeatureCollection<GeoJSON.Point, BikeShareFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: stations.map((station) => ({
      type: "Feature" as const,
      id: station.stationId,
      geometry: {
        type: "Point" as const,
        coordinates: [station.lon, station.lat],
      },
      properties: {
        stationId: station.stationId,
        name: station.name,
        bucket: bucketFor(station),
        label:
          station.bikesAvailable === null ? "" : String(station.bikesAvailable),
      },
    })),
  };
}
