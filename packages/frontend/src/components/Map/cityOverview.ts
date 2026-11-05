import type maplibregl from "../../map/maplibre.ts";

interface CoveredCity {
  id: string;
  name: string;
  center: { lat: number; lon: number };
}

/** City markers share the stops source; this property tells them apart. */
export const IS_CITY: maplibregl.ExpressionSpecification = ["==", ["get", "kind"], "city"];
export const IS_STOP: maplibregl.ExpressionSpecification = ["!=", ["get", "kind"], "city"];

/** One static marker per covered city, shown only when zoomed far out. */
export function cityOverviewFeatures(cities: readonly CoveredCity[]): GeoJSON.Feature<GeoJSON.Point>[] {
  return cities.map((city) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [city.center.lon, city.center.lat] },
    properties: { id: `city:${city.id}`, kind: "city", cityId: city.id, name: city.name },
  }));
}
