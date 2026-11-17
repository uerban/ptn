import { WalkGraphUnavailableError } from "./walkGraphAvailability.ts";
import { validPedestrianRoute } from "./pedestrianEvidence.ts";
import type { LatLon, RaptorItinerary } from "@pt/shared";
import type { WalkRoute } from "./walkGraphClient.ts";

/** Revalidate transfer walks against the same local pedestrian provider as
 * direct walking. Keep transfer buffers; do not turn buffered time into metres. */
export async function transferWalkEvidence(
  itineraries: RaptorItinerary[], stops: {id:string;lat:number;lon:number}[],
  routeFor: (from:LatLon,to:LatLon)=>Promise<WalkRoute|null>, speed:number,
): Promise<RaptorItinerary[]> {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("Invalid pedestrian speed");
  const locations=new Map(stops.map(s=>[s.id,{lat:s.lat,lon:s.lon}]));
  const routes=new Map<string,Promise<WalkRoute|null>>();
  const retained:RaptorItinerary[]=[];
  for(const itinerary of itineraries) {
    const legs=[];
    let feasible=true;
    for(const leg of itinerary.legs) {
      if(leg.type!=="walk") {legs.push(leg);continue;}
      const from=locations.get(leg.fromStopId),to=locations.get(leg.toStopId);
      if(!from||!to) {feasible=false;break;}
      const key=JSON.stringify([leg.fromStopId,leg.toStopId]);
      if(!routes.has(key)) routes.set(key,routeFor(from,to));
      let route: WalkRoute | null;
      try { route=await routes.get(key)!; }
      catch (error) {
        if (!(error instanceof WalkGraphUnavailableError)) throw error;
        // Temporary absence is not proof that the engine's footpath is invalid.
        // Keep it without invented physical distance.
        legs.push(leg);
        continue;
      }
      if(!validPedestrianRoute(route)) {
        feasible=false;break;
      }
      const duration = Math.ceil(route.distanceMeters / speed);
      // Keep the planned arrival when physical movement fits its interval;
      // otherwise extend the walk. The next effective boarding (after RT),
      // not the engine's estimated walk end, is the feasibility deadline.
      // feasibleRtCandidates shifts this duration after a delayed arrival and
      // rejects any resulting overlap without shortening physical movement.
      const arriveSecs = Math.max(leg.arriveSecs, leg.departSecs + duration);
      legs.push({...leg, departSecs: arriveSecs - duration, arriveSecs, distanceMeters:route.distanceMeters});
    }
    if(feasible) retained.push({...itinerary,legs,alightSecs:legs.at(-1)?.arriveSecs ?? itinerary.alightSecs});
  }
  return retained;
}
