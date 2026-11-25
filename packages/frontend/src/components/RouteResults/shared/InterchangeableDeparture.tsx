import { useEffect, useRef, useState } from "react";
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
  findPlans?: (primary: Itinerary, signal: AbortSignal) => Promise<Itinerary[]>;
}

export function InterchangeableDeparture({ itineraries, onSelect, earliestLeaveMs, arriveByMs, feedTz, findPlans }: Props) {
  const { t, formattingLocale } = useTranslation();
  const primary = itineraries[0];
  const request = useRef<AbortController | undefined>(undefined);
  const [result, setResult] = useState<{ primary: Itinerary; plans: Itinerary[] | null; finder: Props["findPlans"] }>();
  useEffect(() => () => request.current?.abort(), [primary, findPlans]);
  const current = result?.primary === primary && result.finder === findPlans ? result : undefined;
  const choice = useRtStore((state) => [...itineraries.slice(1), ...(current?.plans ?? [])].find((candidate) =>
    interchangeableRide(itineraries[0], candidate, { earliestLeaveMs, arriveByMs }) &&
    candidate.legs.every((leg) => {
      const live = leg.tripId ? state.getTripDelay(leg.tripId) : null;
      return !live || (!live.cancelled && !live.deleted && live.delaySeconds === (leg.appliedDelaySeconds ?? 0));
    }),
  ));
  if (!choice) {
    if (!findPlans || primary.transfers < 1) return null;
    const loading = current?.plans === null;
    return (
      <div className="px-3 pb-2">
        {current && !loading ? <p role="status" className="text-sm text-fg-secondary">
          {t("search.no_alternate_ride", "No other verified departure found")}
        </p> : <button type="button" className="text-sm text-accent underline" disabled={loading} onClick={() => {
          request.current?.abort();
          const controller = new AbortController();
          request.current = controller;
          setResult({ primary, finder: findPlans, plans: null });
          void findPlans(primary, controller.signal).then((plans) => {
            if (!controller.signal.aborted) setResult({ primary, finder: findPlans, plans });
          }, () => {
            if (!controller.signal.aborted) setResult({ primary, finder: findPlans, plans: [] });
          });
        }}>{loading ? t("search.looking_for_departures", "Checking departures…") :
          t("search.check_other_departures", "Check other departures")}</button>}
      </div>
    );
  }
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
