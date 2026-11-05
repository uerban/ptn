import type { Segment } from "./legHelpers.ts";

/**
 * Where the rider gets on, and how far away that is.
 *
 * Derived from the segment list rather than from the search endpoints, because
 * the itinerary already encodes the distinction and the endpoints do not: a
 * leading non-transfer walk means the trip starts somewhere other than the
 * boarding stop (a dropped pin, an address, or the far side of the road from a
 * same-named stop), while a trip whose first segment is the ride starts where
 * the rider is already standing.
 *
 * Shared by the accessible name (`itineraryAriaLabel`) and the visible
 * `BoardingLine` so the two can never disagree about which stop a card boards
 * at — they were separately wrong about it before, in different ways.
 */
export interface Boarding {
  /** `from.name` of the first ride leg. */
  stopName: string;
  /**
   * Metres from the trip's origin to the boarding stop, or null when there is
   * no walk (`atOrigin`) or the feed carried no distance for it.
   *
   * `toSegments` coerces a walk leg with no `distanceMeters` to 0, so a zero
   * there means "not measured", not "zero metres" — it must never be rendered
   * as a distance. Null is that case, made explicit.
   */
  meters: number | null;
  /** True when the rider is already at the boarding stop; nothing to walk. */
  atOrigin: boolean;
}

/** Null for a walk-only itinerary — nothing is boarded. */
export function deriveBoarding(segments: Segment[]): Boarding | null {
  const firstRide = segments.find((s) => s.kind === "ride");
  if (!firstRide || firstRide.kind !== "ride") return null;

  const lead = segments[0];
  const accessWalk =
    lead?.kind === "walk" && !lead.transferWalk ? lead : null;

  // A walk whose endpoints carry the same stop id is not a walk between
  // places; it is the at-origin case wearing a leg.
  const sameStop =
    accessWalk !== null &&
    !!accessWalk.leg.from.stopId &&
    accessWalk.leg.from.stopId === accessWalk.leg.to.stopId;

  if (!accessWalk || sameStop) {
    return { stopName: firstRide.leg.from.name, meters: null, atOrigin: true };
  }
  return {
    stopName: firstRide.leg.from.name,
    meters: accessWalk.meters > 0 ? accessWalk.meters : null,
    atOrigin: false,
  };
}
