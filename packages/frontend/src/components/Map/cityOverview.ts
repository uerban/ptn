import type maplibregl from "../../map/maplibre.ts";

interface CoveredCity {
  id: string;
  name: string;
  center: { lat: number; lon: number };
  bbox?: {minLat: number; minLon: number; maxLat: number; maxLon: number};
}

/** City markers share the stops source; this property tells them apart. */
export const IS_CITY: maplibregl.ExpressionSpecification = ["==", ["get", "kind"], "city"];
export const IS_STOP: maplibregl.ExpressionSpecification = ["!=", ["get", "kind"], "city"];

/** Coverage-area scaling uses longitude correction at the city's latitude.
 * A bounded logarithmic scale keeps small areas visible and large ones modest. */
export function cityMarkerRadius(city: CoveredCity): number {
  if (!city.bbox) return 8;
  const b = city.bbox;
  const area = Math.abs((b.maxLat - b.minLat) * (b.maxLon - b.minLon))
    * 111.2 ** 2 * Math.max(0, Math.cos(city.center.lat * Math.PI / 180));
  return Math.max(6, Math.min(16, 6 + 2 * Math.log10(1 + area / 10)));
}

/** One static marker per covered city, shown only when zoomed far out. */
export function cityOverviewFeatures(cities: readonly CoveredCity[]): GeoJSON.Feature<GeoJSON.Point>[] {
  return cities.map((city) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [city.center.lon, city.center.lat] },
    properties: { id: `city:${city.id}`, kind: "city", cityId: city.id, name: city.name, radius: cityMarkerRadius(city) },
  }));
}
