/**
 * Decode a micromap artifact into the four GeoJSON sources MapLibre draws.
 *
 * Kept separate from the layer component so the decode is testable without a
 * map, and so a city switch can decode off the render path.
 */
import { decodePolyline } from "../../utils/polyline.ts";
import type { MicromapArtifact, MicromapArea } from "./types.ts";

export interface MicromapAreaProperties {
  kind: "water" | "green";
}

export interface MicromapLineProperties {
  cls: string;
}

export interface MicromapPlaceProperties {
  name: string;
  rank: number;
}

export interface MicromapGeoJson {
  areas: GeoJSON.FeatureCollection<GeoJSON.Polygon, MicromapAreaProperties>;
  waterways: GeoJSON.FeatureCollection<
    GeoJSON.LineString,
    MicromapLineProperties
  >;
  roads: GeoJSON.FeatureCollection<GeoJSON.LineString, MicromapLineProperties>;
  places: GeoJSON.FeatureCollection<GeoJSON.Point, MicromapPlaceProperties>;
}

export const EMPTY_MICROMAP_GEOJSON: MicromapGeoJson = {
  areas: { type: "FeatureCollection", features: [] },
  waterways: { type: "FeatureCollection", features: [] },
  roads: { type: "FeatureCollection", features: [] },
  places: { type: "FeatureCollection", features: [] },
};

function ringToCoordinates(encoded: string): [number, number][] {
  const points = decodePolyline(encoded).map(
    (p) => [p.lon, p.lat] as [number, number],
  );
  if (points.length < 3) return [];
  const first = points[0];
  const last = points[points.length - 1];
  // The generator closes its rings, but a truncated artifact must not produce
  // an open polygon — MapLibre renders those as a filled wedge.
  if (first[0] !== last[0] || first[1] !== last[1]) points.push(first);
  return points.length >= 4 ? points : [];
}

function areaFeatures(
  areas: readonly MicromapArea[],
  kind: MicromapAreaProperties["kind"],
): GeoJSON.Feature<GeoJSON.Polygon, MicromapAreaProperties>[] {
  const features: GeoJSON.Feature<GeoJSON.Polygon, MicromapAreaProperties>[] =
    [];
  for (const area of areas) {
    const rings = area.r
      .map(ringToCoordinates)
      .filter((ring) => ring.length >= 4);
    if (rings.length === 0) continue;
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: { type: "Polygon", coordinates: rings },
    });
  }
  return features;
}

function lineFeatures(
  lines: readonly { c: string; g: string }[],
): GeoJSON.Feature<GeoJSON.LineString, MicromapLineProperties>[] {
  const features: GeoJSON.Feature<
    GeoJSON.LineString,
    MicromapLineProperties
  >[] = [];
  for (const line of lines) {
    const coordinates = decodePolyline(line.g).map(
      (p) => [p.lon, p.lat] as [number, number],
    );
    if (coordinates.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { cls: line.c },
      geometry: { type: "LineString", coordinates },
    });
  }
  return features;
}

export function micromapToGeoJson(artifact: MicromapArtifact): MicromapGeoJson {
  return {
    // Green first, water second: lakes sit on top of the park they border.
    areas: {
      type: "FeatureCollection",
      features: [
        ...areaFeatures(artifact.green, "green"),
        ...areaFeatures(artifact.water, "water"),
      ],
    },
    waterways: {
      type: "FeatureCollection",
      features: lineFeatures(artifact.waterways),
    },
    roads: {
      type: "FeatureCollection",
      features: lineFeatures(artifact.roads),
    },
    places: {
      type: "FeatureCollection",
      features: artifact.places.map((place) => ({
        type: "Feature" as const,
        properties: { name: place.n, rank: place.r },
        geometry: { type: "Point" as const, coordinates: [place.x, place.y] },
      })),
    },
  };
}
