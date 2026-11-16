import { WalkGraphUnavailableError } from "./walkGraphClient.ts";
import type { WalkRoute } from "./walkGraphClient.ts";

/** Geometry and physical distance must both be usable before route evidence
 * affects a candidate. A provider failure is never a straight-line route. */
export function validPedestrianRoute(route: WalkRoute | null): route is WalkRoute {
  return !!route && Number.isFinite(route.distanceMeters) && route.distanceMeters >= 0
    && route.coords.length >= 2 && route.coords.every(([lon, lat]) =>
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
}


export async function optionalPedestrianRoute(load: () => Promise<WalkRoute | null>): Promise<WalkRoute | null> {
  try { return await load(); }
  catch (error) {
    if (error instanceof WalkGraphUnavailableError) return null;
    throw error;
  }
}
