/**
 * Metres on a local grid around Vilnius, converted with the same Earth radius
 * as `haversineDistance`, so a distance along one axis is exact to the metre.
 */
import type { LatLon } from "@pt/shared";

/** The grid's origin. */
export const LAT0 = 54.6872;
export const LON0 = 25.2797;

const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;

/** The point `northM` metres north and `eastM` metres east of the origin. */
export function at(northM: number, eastM = 0): LatLon {
  return {
    lat: LAT0 + northM / M_PER_DEG_LAT,
    lon: LON0 + eastM / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180)),
  };
}
