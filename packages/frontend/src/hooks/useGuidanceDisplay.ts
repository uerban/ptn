import { useMemo } from "react";
import { COUNTDOWN_INTERVAL_MS } from "@pt/shared/constants";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import {
  selectPreStopBufferSeconds,
  selectRunSpeedRatio,
  useSettingsStore,
} from "../stores/settingsStore.ts";
import { useFirstRideLive } from "./useLiveRt.ts";
import { useServerNow } from "./useServerNow.ts";
import {
  deriveItineraryDisplay,
  type ItineraryDisplay,
} from "../components/RouteResults/shared/itineraryDisplay.ts";

export interface GuidanceDisplay {
  /** null when no guidance is running. */
  display: ItineraryDisplay | null;
  /** The clock `display` was derived at. */
  referenceNowMs: number;
}

/**
 * The guided itinerary's display, kept live: re-read on the map countdown's
 * tick, against the walk still ahead of the rider, and with the first ride
 * moved by whatever live RT delay it has beyond the one the plan was made
 * with. The single source for everything guidance says about catching the
 * first departure — the step list and the departure reminders read the same.
 */
export function useGuidanceDisplay(): GuidanceDisplay {
  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const walkingProgress = useGuidanceStore((s) => s.walkingProgress);
  const bufferSeconds = useSettingsStore(selectPreStopBufferSeconds);
  const runSpeedRatio = useSettingsStore(selectRunSpeedRatio);
  const referenceNowMs = useServerNow(COUNTDOWN_INTERVAL_MS, phase !== "idle" && itinerary !== null);

  const live = useFirstRideLive(itinerary);
  const remainingFraction =
    itinerary?.legs[currentLegIndex]?.mode === "WALK"
      ? (walkingProgress?.remainingFraction ?? 1)
      : 1;

  const display = useMemo(
    () =>
      itinerary
        ? deriveItineraryDisplay(itinerary, {
            referenceNowMs,
            bufferSeconds,
            runSpeedRatio,
            underway: { legIndex: currentLegIndex, remainingFraction },
            firstDepartureShiftSeconds: live.shiftSeconds,
            firstRideCancelled: live.cancelled,
            firstRideRemoved: live.removed,
          })
        : null,
    [
      itinerary,
      referenceNowMs,
      bufferSeconds,
      runSpeedRatio,
      currentLegIndex,
      remainingFraction,
      live.shiftSeconds,
      live.cancelled,
      live.removed,
    ],
  );

  return { display, referenceNowMs };
}
