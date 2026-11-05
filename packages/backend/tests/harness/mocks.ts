import { createHash } from "node:crypto";
import type { Itinerary, RoutingBundleShape, TripResult } from "@pt/shared";

/**
 * Minimal GtfsStore stand-in that exposes just the shapes-artifact surface
 * the HTTP handler depends on. Serializes the body once and derives the
 * sha256 hash so tests can reference the same value the real store would.
 */
export function makeStoreWithShapes(shapes: RoutingBundleShape[]) {
  const body = JSON.stringify({ shapes });
  const hash = createHash("sha256").update(body).digest("hex");
  return {
    getShapesBody: () => body,
    getShapesHash: () => hash,
  };
}

/**
 * The transit-free walk from a `planTrip` result, or `undefined` if upstream
 * offered none.
 *
 * Scenarios that declare `expectModes: ["WALK"]` are asserting something about
 * the walk, so that is what their duration bound has to measure. Minimising
 * over `itineraries` + `direct` instead makes the bound depend on whether a
 * transit option happened to be quicker at query time — a live, timetable-
 * dependent quantity — which turns a fixed numeric threshold into a coin flip.
 *
 * Selects on leg modes rather than taking `direct[0]`: `direct` holds journeys
 * that use no transit, which upstream may also answer with a bike or scooter
 * leg. Picks the fastest qualifying walk when several come back.
 */
export function walkJourney(result: TripResult): Itinerary | undefined {
  const walks = (result.direct ?? []).filter(
    (j) => j.legs.length > 0 && j.legs.every((l) => l.mode === "WALK")
  );
  if (walks.length === 0) return undefined;
  return walks.reduce((a, b) => (b.durationSeconds < a.durationSeconds ? b : a));
}
