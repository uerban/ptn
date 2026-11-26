import type { FirstRideConstraint } from "@pt/shared";
import { useEffect, useState } from "react";
import type { Itinerary } from "@pt/shared";
import { useFirstRideLive } from "../../../hooks/useLiveRt.ts";
import { useSettingsStore } from "../../../stores/settingsStore.ts";
import { useRtStore } from "../../../stores/rtStore.ts";
import { useTranslation } from "../../../i18n/index.ts";
import { serverTime } from "../../../services/serverTime.ts";
import { selectVerifiedDifferentJourney, selectVerifiedLaterJourney } from "../../../services/verifiedLaterJourney.ts";
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
  findDifferentPlans?: (at: Date, signal: AbortSignal, excludeRouteId: string) => Promise<Itinerary[]>;
  findLaterPlans?: (at: Date, signal: AbortSignal, firstRide: FirstRideConstraint & { direct: boolean }) => Promise<Itinerary[]>;
}

export function LaterJourney({
  itineraries, onSelect, referenceNowMs, bufferSeconds, runSpeedRatio, departAtMs, arriveByMs, feedTz, findLaterPlans, findDifferentPlans,
}: Props) {
  const { t, formattingLocale } = useTranslation();
  const primary = itineraries[0];
  const [request, setRequest] = useState<{ primary: Itinerary; find: Props["findLaterPlans"] }>();
  const requested = request?.primary === primary && request.find === findLaterPlans;
  const [probe, setProbe] = useState<{
    primary: Itinerary; find: NonNullable<Props["findLaterPlans"]>; differentFinder: Props["findDifferentPlans"]; plans: Itinerary[]; differentPlans: Itinerary[];
  }>();
  const completed = probe?.primary === primary && probe.find === findLaterPlans && probe.differentFinder === findDifferentPlans;
  const additional = completed ? probe.plans : [];
  const firstRide = primary.legs.find((leg) => leg.mode !== "WALK");
  const showJourneyAlternatives = useSettingsStore((state) => state.showJourneyAlternatives);
  const canRequest = import.meta.env.VITE_PTN_SHOW_JOURNEY_ALTERNATIVES === "1" && showJourneyAlternatives &&
    itineraries.length === 1 && !!findLaterPlans && !!firstRide?.routeId && !!firstRide.from.stopId &&
    !!firstRide.to.stopId && !primary.cancelled && !primary.timingUnreliable;
  const live = useFirstRideLive(primary);
  const display = deriveItineraryDisplay(primary, {
    referenceNowMs, bufferSeconds, runSpeedRatio, earliestLeaveMs: departAtMs,
    firstDepartureShiftSeconds: live.shiftSeconds, firstRideCancelled: live.cancelled,
    firstRideRemoved: live.removed,
  });
  const missed = display.catchStatus === "departed" || display.catchStatus === "likely-miss";
  const needsFallback = import.meta.env.VITE_PTN_VERIFIED_LATER_JOURNEY === "1" && missed;
  const showAlternative = needsFallback || (canRequest && requested);
  const eligible = (plan: Itinerary, state: ReturnType<typeof useRtStore.getState>) => plan.legs.every((leg) => {
    const live = leg.tripId ? state.getTripDelay(leg.tripId) : null;
    return !live || (!live.cancelled && !live.deleted && live.delaySeconds === (leg.appliedDelaySeconds ?? 0));
  });
  const constraints = { earliestLeaveMs: Math.max(referenceNowMs, departAtMs ?? referenceNowMs), arriveByMs };
  const later = useRtStore((state) => showAlternative
    ? selectVerifiedLaterJourney(primary, [...itineraries, ...additional].filter((plan) => eligible(plan, state)), constraints)
    : null);
  const different = useRtStore((state) => showAlternative && canRequest && requested && completed && firstRide?.routeId
    ? selectVerifiedDifferentJourney(firstRide.routeId, probe.differentPlans.filter((plan) => eligible(plan, state)), constraints)
    : null);
  const retainedLater = later !== null && itineraries.includes(later);
  const primaryLeaveMs = Date.parse(primary.departureTime);
  const explicitBoardingFloor = firstRide ? Date.parse(firstRide.departureTime) + 1_000 : NaN;
  const probeFloor = canRequest && requested ? explicitBoardingFloor : primaryLeaveMs + 1_000;
  const lookupFloor = canRequest && !missed ? explicitBoardingFloor : probeFloor;
  const withinDeadline = arriveByMs === undefined ||
    Math.max(referenceNowMs, departAtMs ?? -Infinity, lookupFloor) < arriveByMs;
  useEffect(() => {
    if (!findLaterPlans || !showAlternative || retainedLater || !Number.isFinite(probeFloor) || !withinDeadline) return;
    const controller = new AbortController();
    // A rider asking for another option can search explicitly after the
    // planned boarding. A missed departure keeps the earlier access floor.
    const departureFloor = Math.max(serverTime.now(), departAtMs ?? -Infinity, probeFloor);
    if (arriveByMs !== undefined && departureFloor >= arriveByMs) return;
    const rides = primary.legs.filter((leg) => leg.mode !== "WALK");
    const ride = rides[0];
    const routeId = ride?.routeId;
    const boardStopId = ride?.from.stopId;
    const alightStopId = ride?.to.stopId;
    if (!routeId || !boardStopId || !alightStopId) return;
    void (async () => {
      const plans = await findLaterPlans(new Date(departureFloor), controller.signal, {
        routeId, boardStopId, alightStopId, direct: rides.length === 1,
      }).catch(() => []);
      if (controller.signal.aborted) return;
      const differentAt = Math.max(serverTime.now(), departAtMs ?? -Infinity, primaryLeaveMs);
      const differentPlans = requested && canRequest && findDifferentPlans &&
        (arriveByMs === undefined || differentAt < arriveByMs)
        ? await findDifferentPlans(new Date(differentAt), controller.signal, routeId).catch(() => [])
        : [];
      if (!controller.signal.aborted) setProbe({ primary, find: findLaterPlans, differentFinder: findDifferentPlans, plans, differentPlans });
    })();

    return () => controller.abort();
  }, [findLaterPlans, showAlternative, primary, retainedLater, probeFloor, departAtMs, arriveByMs, withinDeadline, requested, canRequest, findDifferentPlans, primaryLeaveMs]);

  if (!later && !different) {
    if (!canRequest || missed || !Number.isFinite(probeFloor) || !withinDeadline ||
      display.catchStatus === "cancelled" || display.catchStatus === "removed") return null;
    return (
      <div className="px-3 pb-2">
        {requested && completed ? <p role="status" className="text-sm text-fg-secondary">
          {t("search.no_later_journey", "No later journey found")}
        </p> : <button type="button" className="text-sm text-accent underline" disabled={requested}
          onClick={() => setRequest({ primary, find: findLaterPlans })}>
          {requested ? t("search.looking_for_departures", "Checking departures…") :
            t("search.show_journey_alternatives", "Show alternatives")}
        </button>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1 px-3 pb-2">
      {later && <button type="button" onClick={() => onSelect(later)} className="text-left text-sm text-accent underline">
        {t("search.later_journey", "Also leaves at {departure} · arrives at {arrival}")
          .replace("{departure}", formatTime(later.legs[0].departureTime, formattingLocale, feedTz))
          .replace("{arrival}", formatTime(later.arrivalTime, formattingLocale, feedTz))}
      </button>}
      {different && <button type="button" onClick={() => onSelect(different)} className="text-left text-sm text-accent underline">
        {t("search.different_journey", "Take {lines} · leaves {departure} · arrives {arrival}")
          .replace("{lines}", different.legs.filter((leg) => leg.mode !== "WALK").map((leg) => leg.routeShortName ?? leg.mode).join(" → "))
          .replace("{departure}", formatTime(different.legs[0].departureTime, formattingLocale, feedTz))
          .replace("{arrival}", formatTime(different.arrivalTime, formattingLocale, feedTz))}
        {" · "}{t("search.alternative_transfer_count", "Transfers: {n}").replace("{n}", String(different.transfers))}
      </button>}
    </div>
  );
}
