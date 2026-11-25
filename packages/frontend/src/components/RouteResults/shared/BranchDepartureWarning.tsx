import { useMemo } from "react";
import type { Itinerary } from "@pt/shared";
import { useTranslation } from "../../../i18n/index.ts";
import { branchDepartureWarning } from "../../../services/branchDepartureWarning.ts";
import { makeGetNextDeparture } from "../../../services/nextDeparture.ts";
import { useGtfsDataStore } from "../../../stores/gtfsDataStore.ts";
import { useRtStore } from "../../../stores/rtStore.ts";
import { formatTime } from "./format.ts";

export function BranchDepartureWarning({ itinerary, nowMs, feedTz }: {
  itinerary: Itinerary;
  nowMs: number;
  feedTz?: string;
}) {
  const { t, formattingLocale } = useTranslation();
  const index = useGtfsDataStore((state) => state.raptorIndex);
  const ride = itinerary.legs.find((leg) => leg.mode !== "WALK");
  const plannedMs = ride ? Date.parse(ride.departureTime) : NaN;
  const updates = useRtStore((state) => state.updates);
  const next = useMemo(() => {
    const state = useRtStore.getState();
    if (itinerary.cancelled || itinerary.timingUnreliable || !index?.patternsAtStop || !ride?.routeId ||
      !ride.from.stopId || !ride.tripId || !(plannedMs > nowMs)) return null;
    const live = state.getTripDelay(ride.tripId);
    if (live && (live.cancelled || live.deleted || live.delaySeconds !== (ride.appliedDelaySeconds ?? 0))) return null;
    return makeGetNextDeparture(index, state, () => plannedMs + 1_000, feedTz)(ride.routeId, ride.from.stopId);
  }, [index, ride, plannedMs, nowMs, feedTz, itinerary.cancelled, itinerary.timingUnreliable, updates]);
  if (!index || !ride || !next || !branchDepartureWarning(index, ride, next)) return null;
  return (
    <p className="px-3 pb-2 text-sm text-warning">
      {t("search.branch_departure_warning", "Take {line} toward {planned} at {time}. The {otherTime} toward {other} skips {stop}.")
        .replace("{line}", next.routeShortName).replace("{planned}", ride.headsign ?? "")
        .replace("{time}", formatTime(ride.departureTime, formattingLocale, feedTz))
        .replace("{otherTime}", formatTime(new Date(next.departureMs).toISOString(), formattingLocale, feedTz))
        .replace("{other}", next.headsign).replace("{stop}", ride.to.name)}
    </p>
  );
}
