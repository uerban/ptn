import type { LatLon, RaptorItinerary } from "@pt/shared";
import type { WalkRoute } from "./walkGraphClient.ts";

/** Revalidate transfer walks against the same local pedestrian provider as
 * direct walking. Keep transfer buffers; do not turn buffered time into metres. */
export async function transferWalkEvidence(
  itineraries: RaptorItinerary[], stops: {id:string;lat:number;lon:number}[],
  routeFor: (from:LatLon,to:LatLon)=>Promise<WalkRoute|null>, speed:number,
): Promise<RaptorItinerary[]> {
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
      const route=await routes.get(key)!;
      if(!route || !Number.isFinite(route.distanceMeters) || route.distanceMeters<0
        || Math.ceil(route.distanceMeters/speed)>leg.arriveSecs-leg.departSecs) {
        feasible=false;break;
      }
      legs.push({...leg,distanceMeters:route.distanceMeters});
    }
    if(feasible) retained.push({...itinerary,legs});
  }
  return retained;
}
