import type { Itinerary } from "@pt/shared";
import { useFirstRideLive } from "../../../hooks/useLiveRt.ts";
import { useRtStore } from "../../../stores/rtStore.ts";
import { useTranslation } from "../../../i18n/index.ts";
import { selectVerifiedLaterJourney } from "../../../services/verifiedLaterJourney.ts";
import { formatTime } from "./format.ts";
import { deriveItineraryDisplay } from "./itineraryDisplay.ts";

interface Props {
  itineraries: Itinerary[];
  onSelect: (itinerary: Itinerary) => void;
  referenceNowMs: number;
  bufferSeconds: number;
  runSpeedRatio?: number;
  departAtMs?: number;
  arriveByMs?: number;
  feedTz?: string;
}

export function LaterJourney({
  itineraries, onSelect, referenceNowMs, bufferSeconds, runSpeedRatio, departAtMs, arriveByMs, feedTz,
}: Props) {
  const { t, formattingLocale } = useTranslation();
  const primary = itineraries[0];
  const live = useFirstRideLive(primary);
  const display = deriveItineraryDisplay(primary, {
    referenceNowMs, bufferSeconds, runSpeedRatio, earliestLeaveMs: departAtMs,
    firstDepartureShiftSeconds: live.shiftSeconds, firstRideCancelled: live.cancelled,
    firstRideRemoved: live.removed,
  });
  const needsFallback = display.catchStatus === "departed" || display.catchStatus === "likely-miss";
  const later = useRtStore((state) => {
    if (!needsFallback) return null;
    const currentPlans = itineraries.filter((plan) => plan.legs.every((leg) => {
      const live = leg.tripId ? state.getTripDelay(leg.tripId) : null;
      return !live || (!live.cancelled && !live.deleted && live.delaySeconds === (leg.appliedDelaySeconds ?? 0));
    }));
    return selectVerifiedLaterJourney(primary, currentPlans, {
      earliestLeaveMs: Math.max(referenceNowMs, departAtMs ?? referenceNowMs), arriveByMs,
    });
  });
  if (!later) return null;
  const departure = formatTime(later.departureTime, formattingLocale, feedTz);
  const arrival = formatTime(later.arrivalTime, formattingLocale, feedTz);
  return (
    <div className="px-3 pb-2">
      <button type="button" onClick={() => onSelect(later)} className="text-sm text-accent underline">
        {t("search.later_journey", "Also leaves at {departure} · arrives at {arrival}")
          .replace("{departure}", departure).replace("{arrival}", arrival)}
      </button>
    </div>
  );
}
