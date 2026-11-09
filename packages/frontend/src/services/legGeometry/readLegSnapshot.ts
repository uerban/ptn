import { captureCityData, type CityDataRead } from "../cityData.ts";
import type { RaptorLeg } from "@pt/shared";

export interface LegSnapshot {
  route?: { id: string; stopIds: string[] };
  trip?: { shapeId?: string };
  shape?: { shapeId: string; encodedPolyline: string; source: "gtfs" };
  stops?: Array<{ id: string; lat: number; lon: number } | undefined>;
}

export async function readLegSnapshot(leg: RaptorLeg, data: CityDataRead = captureCityData()): Promise<LegSnapshot> {
  if (leg.type !== "transit") return {};
  return data.runSnapshot(async () => {
    const route = await data.gtfsRoutes.get(leg.routeId);
    const trip = await data.gtfsTrips.get(leg.tripId);
    const shape = trip?.shapeId ? await data.gtfsShapes.get(trip.shapeId) : undefined;
    // When the leg carries patternStopIds (PatternMode On), slice that
    // sequence — it may contain branch/variant stops absent from the display
    // route's canonical stopIds. Fall back to the display route's stopIds
    // when patternStopIds is absent (PatternMode Off / legacy legs).
    const stopIdSlice = leg.patternStopIds
      ? leg.patternStopIds.slice(leg.boardStopIdx, leg.alightStopIdx + 1)
      : route?.stopIds.slice(leg.boardStopIdx, leg.alightStopIdx + 1);
    const stops = stopIdSlice
      ? await data.gtfsStops.bulkGet(stopIdSlice)
      : undefined;
    data.assertCurrent();
    return {
      route: route ? { id: route.id, stopIds: route.stopIds } : undefined,
      trip: trip ? { shapeId: trip.shapeId } : undefined,
      shape,
      stops,
    };
  });
}
