import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { getCityProfile } from "../harness/cities/index.js";

/**
 * Haversine distance between two lat/lon points, in kilometers.
 */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const aa = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(aa));
}

export interface CityBboxValidationOptions {
  /**
   * Max allowed distance (km) from the city's declared center to the
   * centroid of loaded stops. A typical legitimate feed sits within ~30 km
   * of its city center (metropolitan extents rarely exceed that radius);
   * 200 km is generous padding that still rejects a wrong-city feed,
   * which will be hundreds to thousands of km away.
   */
  maxCentroidDistanceKm: number;
}

export const DEFAULT_CITY_BBOX_OPTIONS: CityBboxValidationOptions = {
  maxCentroidDistanceKm: 200,
};

export interface CityBboxValidationResult {
  cityId: string;
  centroid: { lat: number; lon: number };
  declaredCenter: { lat: number; lon: number };
  distanceKm: number;
  stopCount: number;
}

/**
 * Verify that the loaded GTFS `indexes` plausibly correspond to `cityId`.
 *
 * Computes the centroid of all stops and fails if it is further from the
 * city profile's declared center than `opts.maxCentroidDistanceKm`.
 *
 * Purpose: catch deployment-time environment drift — wrong CITY_ID, stale
 * volumes that cross-populated, swapped GTFS_STATIC_URL env, or a misrouted
 * reverse proxy — before we serve a user wrong-city data silently.
 *
 * Unknown cityIds pass through without validation (profiles are optional by
 * design; self-hosters may run cities we don't ship a profile for).
 */
export function validateCityBbox(
  canonical: CanonicalStore,
  cityId: string,
  opts: CityBboxValidationOptions = DEFAULT_CITY_BBOX_OPTIONS,
): CityBboxValidationResult | null {
  const profile = getCityProfile(cityId);
  if (!profile) return null;

  if (canonical.stopCount === 0) {
    throw new Error(
      `City validation failed for '${cityId}': no stops loaded (GTFS feed empty or parse failed).`,
    );
  }

  let sumLat = 0;
  let sumLon = 0;
  let count = 0;
  canonical.iterStops((_id, s) => {
    sumLat += s.lat;
    sumLon += s.lon;
    count++;
  });
  const centroidLat = sumLat / count;
  const centroidLon = sumLon / count;

  const distKm = haversineKm(
    centroidLat,
    centroidLon,
    profile.center.lat,
    profile.center.lon,
  );

  if (distKm > opts.maxCentroidDistanceKm) {
    throw new Error(
      `City validation failed for '${cityId}': centroid of ${count} stops ` +
      `(${centroidLat.toFixed(4)}, ${centroidLon.toFixed(4)}) is ${distKm.toFixed(0)} km ` +
      `from declared center (${profile.center.lat.toFixed(4)}, ${profile.center.lon.toFixed(4)}), ` +
      `exceeding max ${opts.maxCentroidDistanceKm} km. ` +
      `Likely cause: CITY_ID does not match the GTFS feed that was loaded — ` +
      `check GTFS_STATIC_URL and CITY_ID env in your deployment.`,
    );
  }

  return {
    cityId,
    centroid: { lat: centroidLat, lon: centroidLon },
    declaredCenter: { lat: profile.center.lat, lon: profile.center.lon },
    distanceKm: distKm,
    stopCount: count,
  };
}
