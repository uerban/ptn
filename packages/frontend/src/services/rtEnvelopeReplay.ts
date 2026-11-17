import {decodeRouteUpdate} from "@pt/shared/proto";
import {stampRtUpdate, indexRtTrips} from "./rtSnapshot.ts";
import type {RtTripUpdate} from "@pt/shared";
export type RtEnvelopeEvent = {kind: "update"; bytes: Uint8Array; receivedAt: number} | {kind: "remove"; routeIds: string[]};

/** Supplied frontend RouteUpdate history from an empty store. This is not an
 * upstream GTFS-RT decoder or proof of the original live store's provenance. */
export function replayRtEnvelopes(events: RtEnvelopeEvent[], tripIds: string[]) {
  const updates = new Map<string, RtTripUpdate[]>();
  for (const event of events) {
    if (event.kind === "remove") {for (const id of event.routeIds) updates.delete(id);}
    else if (event.kind === "update" && Number.isFinite(event.receivedAt)) {
      const update = decodeRouteUpdate(event.bytes);
      updates.set(update.routeId, stampRtUpdate(update, event.receivedAt));
    } else throw new Error("Unsupported RT envelope event");
  }
  const index = indexRtTrips(updates);
  return tripIds.map(tripId => {
    const trip = index.get(tripId);
    return trip ? {delaySeconds: trip.delaySeconds, cancelled: trip.cancelled, deleted: trip.deleted, receivedAt: trip.receivedAt} : null;
  });
}
