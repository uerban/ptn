import type { Itinerary } from "@pt/shared";
import { useTranslation } from "../../../i18n/index.ts";
import { interchangeableRide } from "../../../services/verifiedLaterJourney.ts";
import { useRtStore } from "../../../stores/rtStore.ts";
import { formatTime } from "./format.ts";

interface Props {
  itineraries: Itinerary[];
  onSelect: (itinerary: Itinerary) => void;
  earliestLeaveMs: number;
  arriveByMs?: number;
  feedTz?: string;
}

export function InterchangeableDeparture({ itineraries, onSelect, earliestLeaveMs, arriveByMs, feedTz }: Props) {
  const { t, formattingLocale } = useTranslation();
  const choice = useRtStore((state) => itineraries.slice(1).find((candidate) =>
    interchangeableRide(itineraries[0], candidate, { earliestLeaveMs, arriveByMs }) &&
    candidate.legs.every((leg) => {
      const live = leg.tripId ? state.getTripDelay(leg.tripId) : null;
      return !live || (!live.cancelled && !live.deleted && live.delaySeconds === (leg.appliedDelaySeconds ?? 0));
    }),
  ));
  if (!choice) return null;
  const ride = interchangeableRide(itineraries[0], choice, { earliestLeaveMs, arriveByMs });
  if (!ride?.routeShortName || !ride.headsign) return null;
  const departure = formatTime(ride.departureTime, formattingLocale, feedTz);
  return (
    <div className="px-3 pb-2">
      <button type="button" className="text-sm text-accent underline" onClick={() => onSelect(choice)}>
        {t("search.alternate_ride", "Take {line} toward {headsign} at {time} instead")
          .replace("{line}", ride.routeShortName).replace("{headsign}", ride.headsign).replace("{time}", departure)}
      </button>
    </div>
  );
}
