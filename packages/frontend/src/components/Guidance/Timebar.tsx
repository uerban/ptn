import type { Itinerary } from "@pt/shared";
import type { Segment } from "../RouteResults/shared/legHelpers.ts";
import { ItineraryBar } from "../RouteResults/shared/ItineraryBar.tsx";

interface TimebarProps {
  itinerary: Itinerary;
  progress: number | null;
  /** Pre-computed segments (incl. buffer-wait). When supplied, ItineraryBar skips toSegments(). */
  segments?: Segment[];
  /** Hide the bar from the AT — caller has rendered a parallel LeaveHint. */
  ariaHidden?: boolean;
}

/** Legacy import shim for ItineraryBar with segments + aria-hidden passthrough. */
export function Timebar({ itinerary, progress, segments, ariaHidden }: TimebarProps) {
  return (
    <ItineraryBar
      itinerary={itinerary}
      progress={progress}
      segments={segments}
      ariaHidden={ariaHidden}
    />
  );
}
