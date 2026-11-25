import { useEffect, useMemo, useRef, useState } from "react";
import type { Itinerary, Leg } from "@pt/shared";
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
  const updates = useRtStore((state) => state.updates);
  const choices = useMemo(() => {
    const state = useRtStore.getState();
    const byRoute = new Map<string, { candidate: Itinerary; ride: Leg; rank: number }>();
    for (const candidate of [...itineraries.slice(1), ...(current?.plans ?? [])]) {
      const ride = interchangeableRide(primary, candidate, { earliestLeaveMs, arriveByMs });
      if (!ride?.routeId || !ride.routeShortName || !ride.headsign) continue;
      if (!candidate.legs.every((leg) => {
        const live = leg.tripId ? state.getTripDelay(leg.tripId) : null;
        return !live || (!live.cancelled && !live.deleted && live.delaySeconds === (leg.appliedDelaySeconds ?? 0));
      })) continue;
      const rank = Date.parse(ride.departureTime);
      const existing = byRoute.get(ride.routeId);
      if (!existing || rank < existing.rank ||
        (rank === existing.rank && Date.parse(candidate.arrivalTime) < Date.parse(existing.candidate.arrivalTime))) {
        byRoute.set(ride.routeId, { candidate, ride, rank });
      }
    }
    return [...byRoute.values()].sort((a, b) => a.rank - b.rank).slice(0, 3);
  }, [itineraries, current, primary, earliestLeaveMs, arriveByMs, updates]);

  const canFind = !!findPlans && primary.transfers >= 1;
  const loading = current?.plans === null;
  if (!choices.length && !canFind) return null;

  function checkOtherDepartures() {
    if (!findPlans) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResult({ primary, finder: findPlans, plans: null });
    void findPlans(primary, controller.signal).then((plans) => {
      if (!controller.signal.aborted) setResult({ primary, finder: findPlans, plans });
    }, () => {
      if (!controller.signal.aborted) setResult({ primary, finder: findPlans, plans: [] });
    });
  }

  return (
    <div className="space-y-1 px-3 pb-2">
      {choices.length > 0 && <ul className="space-y-1">
        {choices.map(({ candidate, ride }) => (
          <li key={ride.routeId}>
            <button type="button" className="text-left text-sm text-accent underline" onClick={() => onSelect(candidate)}>
              {t("search.alternate_ride", "Take {line} toward {headsign} at {time} instead")
                .replace("{line}", ride.routeShortName ?? "").replace("{headsign}", ride.headsign ?? "")
                .replace("{time}", formatTime(ride.departureTime, formattingLocale, feedTz))}
              {" · "}{t("search.alternate_arrival", "Arrives {time}")
                .replace("{time}", formatTime(candidate.arrivalTime, formattingLocale, feedTz))}
            </button>
          </li>
        ))}
      </ul>}
      {canFind && (!current || loading) && <button type="button" className="text-sm text-accent underline"
        disabled={loading} onClick={checkOtherDepartures}>
        {loading ? t("search.looking_for_departures", "Checking departures…") :
          t("search.check_other_departures", "Check other departures")}
      </button>}
      {canFind && current && !loading && choices.length === 0 && <p role="status" className="text-sm text-fg-secondary">
        {t("search.no_alternate_ride", "No other verified departure found")}
      </p>}
    </div>
  );
}
