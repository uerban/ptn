import { useEffect, useRef, useState } from "react";
import type { BaseEndpoint, Itinerary, Leg } from "@pt/shared";
import { canUse, useCanUse } from "../../privacy/canUse.ts";
import { api } from "../../services/api.ts";
import { REALTIME_FLOW } from "../../services/departuresPolicy.ts";
import { liveTransferRouteIds } from "../../services/liveTransferCandidate.ts";
import { excludedRouteIdsForCity } from "../../services/routeGroups.ts";
import { useTranslation } from "../../i18n/index.ts";
import { captureCityData } from "../../services/cityData.ts";
import { convertRaptorResults, serviceDateYmdFor } from "../../services/convertRaptorResults.ts";
import { NEXT_DEPARTURE_FRESHNESS_WINDOW_MS } from "../../services/nextDeparture.ts";
import { resolveToEntryStops } from "../../services/resolveEndpoint.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useRoutingStore } from "../../stores/routingStore.ts";
import { useRtStore } from "../../stores/rtStore.ts";
import { effectiveExcludedModes, useSettingsStore } from "../../stores/settingsStore.ts";

function realtimeStillMatches(leg: Leg, delay: number, now: number, requiresLive: boolean): boolean {
  if (!leg.tripId) return !requiresLive;
  const state = useRtStore.getState();
  const update = state.getTripDelay(leg.tripId);
  if (update?.cancelled || update?.deleted) return false;
  const receivedAt = state.getReceivedAt(leg.tripId);
  const fresh = update && receivedAt !== null && receivedAt <= now &&
    now - receivedAt < NEXT_DEPARTURE_FRESHNESS_WINDOW_MS;
  return fresh ? update.delaySeconds === delay : !requiresLive && delay === 0;
}

function walkingSeconds(legs: Leg[]): number {
  return legs.reduce((total, leg) => total + (leg.mode === "WALK" ? leg.durationSeconds : 0), 0);
}

export function LiveTransferOffer() {
  const { t, formattingLocale } = useTranslation();
  const realtimeAllowed = useCanUse(REALTIME_FLOW);
  const batterySaver = useSettingsStore((state) => import.meta.env.VITE_PTN_SEARCH_POWER_MODES === "1" &&
    state.searchPowerMode === "battery-saver");
  const feedTz = useCityStore((s) => s.activeCity.tz);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const index = useGuidanceStore((s) => s.currentLegIndex);
  const stopsRemaining = useGuidanceStore((s) => s.transitProgress?.stopsRemaining);
  const riderTripId = useGuidanceStore((s) => s.riderTripId);
  const active = itinerary?.legs[index];
  const incomingDelay = useRtStore((state) => active?.tripId ? state.getTripDelay(active.tripId)?.delaySeconds : undefined);
  const incomingReceivedAt = useRtStore((state) => active?.tripId ? state.getReceivedAt(active.tripId) : null);
  const remaining = itinerary?.legs.slice(index + 1);
  const destination = remaining?.at(-1)?.to;
  const controller = useRef<AbortController | null>(null);
  const attempted = useRef<{ itinerary: Itinerary; index: number } | null>(null);
  const releaseOfferRoute = useRef<(() => void) | null>(null);
  const [result, setResult] = useState<{ replacement: Itinerary; tail: Itinerary; walkSaved: number; valid: () => boolean }>();
  const [status, setStatus] = useState<"idle" | "busy" | "empty">("idle");

  useEffect(() => {
    setResult(undefined);
    setStatus("idle");
    return () => {
      controller.current?.abort();
      controller.current = null;
      releaseOfferRoute.current?.();
      releaseOfferRoute.current = null;
    };
  }, [itinerary, index, riderTripId, realtimeAllowed, stopsRemaining]);

  const eligible = realtimeAllowed && itinerary && active?.tripId && active.routeId && active.to.stopId &&
    destination && active.tripId === riderTripId && stopsRemaining === 1 && remaining?.every((leg) => leg.mode === "WALK");

  const request = async () => {
    if (!eligible || !remaining || controller.current ||
        (attempted.current?.itinerary === itinerary && attempted.current.index === index)) return;
    const now = Date.now();
    const delay = useRtStore.getState().getTripDelay(active.tripId!)?.delaySeconds;
    if (document.visibilityState === "hidden" || delay === undefined || delay >= 0 ||
        !realtimeStillMatches(active, delay, now, true)) {
      setStatus("empty");
      return;
    }
    const task = new AbortController();
    controller.current = task;
    attempted.current = { itinerary, index };
    setStatus("busy");
    let releaseDiscovery: (() => void) | undefined;
    try {
      const city = useCityStore.getState().activeCity;
      const raptorIndex = useGtfsDataStore.getState().raptorIndex;
      if (!raptorIndex) return;
      const settings = useSettingsStore.getState();
      const data = captureCityData();
      const stops = await data.gtfsStops.toArray();
      if (task.signal.aborted) return;
      data.assertCurrent();
      const origin = { kind: "stop", stopId: active.to.stopId!, name: active.to.name, ...active.to.location } as const;
      const target: BaseEndpoint = destination.stopId
        ? { kind: "stop", stopId: destination.stopId, name: destination.name, ...destination.location }
        : { kind: "mappoint", label: destination.name, ...destination.location };
      const alightStopIds = new Set(resolveToEntryStops(target, stops, { ...settings, role: "destination" }).map(({ stopId }) => stopId));
      const incomingScheduledArrivalMs = Date.parse(active.arrivalTime) - (active.appliedDelaySeconds ?? 0) * 1000;
      const remainingWalk = walkingSeconds(remaining);
      const currentArrival = incomingScheduledArrivalMs + delay * 1000 + remainingWalk * 1000;
      const excludedRoutes = new Set(excludedRouteIdsForCity(raptorIndex, city, settings));
      excludedRoutes.add(active.routeId!);
      const routeIds = liveTransferRouteIds(raptorIndex, origin.stopId, alightStopIds, excludedRoutes,
        new Set(effectiveExcludedModes(settings, city.defaultExcludedModes)), incomingScheduledArrivalMs, currentArrival, city.tz).slice(0, batterySaver ? 1 : 2);
      const mayReadLive = () => !task.signal.aborted && document.visibilityState !== "hidden" &&
        canUse(REALTIME_FLOW) && useCityStore.getState().activeCity.id === city.id;
      if (!mayReadLive()) return;
      const realtime = useRtStore.getState();
      releaseDiscovery = realtime.retainRoutes(routeIds);
      await Promise.allSettled(routeIds.map(async (routeId) => {
        const alreadyFresh = useRtStore.getState().updates.get(routeId)?.some((trip) =>
          trip.receivedAt !== undefined && trip.receivedAt <= now &&
          now - trip.receivedAt < NEXT_DEPARTURE_FRESHNESS_WINDOW_MS);
        if (alreadyFresh || !mayReadLive()) return;
        const response = await api.fetchRouteRt(routeId, task.signal);
        if (mayReadLive() && response.routeId === routeId) useRtStore.getState().applyUpdate(response);
      }));
      if (!mayReadLive()) return;
      const found = await useRoutingStore.getState().probeLiveTransfer({
        incoming: { tripId: active.tripId!, routeId: active.routeId!, toStopId: origin.stopId },
        incomingScheduledArrivalMs, origin, destination: target, alightStopIds, latestBoardMs: currentArrival, signal: task.signal,
      });
      if (!found || task.signal.aborted) return;
      const [tail] = await convertRaptorResults([found.journey], found.queryTime, origin, target, city.tz,
        serviceDateYmdFor(found.queryTime, city.tz), { origin: origin.name, destination: destination.name });
      const first = tail?.legs[0];
      const walkSaved = remainingWalk - (tail ? walkingSeconds(tail.legs) : remainingWalk);
      const valid = () => {
        const checkedAt = Date.now();
        return !!first && Date.parse(first.departureTime) > checkedAt && mayReadLive() &&
          useCityStore.getState().activeCity.id === city.id && useGtfsDataStore.getState().raptorIndex === raptorIndex &&
          useSettingsStore.getState() === settings && realtimeStillMatches(active, delay, checkedAt, true) &&
          tail.legs.every((leg, i) => realtimeStillMatches(leg, leg.appliedDelaySeconds ?? 0, checkedAt, i === 0));
      };
      if (!tail || task.signal.aborted || !valid() || walkSaved < 60 || Date.parse(tail.arrivalTime) > currentArrival) return;
      const legs = [...itinerary.legs.slice(0, index + 1), ...tail.legs];
      const replacement: Itinerary = {
        legs, departureTime: itinerary.departureTime, arrivalTime: tail.arrivalTime,
        durationSeconds: (Date.parse(tail.arrivalTime) - Date.parse(itinerary.departureTime)) / 1000,
        walkingDistanceMeters: Math.round(tail.walkingDistanceMeters +
          legs.slice(0, index + 1).reduce((total, leg) => total + (leg.mode === "WALK"
            ? leg.distanceMeters ?? leg.durationSeconds * settings.walkSpeedMps : 0), 0)),
        walkingDistanceEstimated: tail.walkingDistanceEstimated ||
          legs.slice(0, index + 1).some((leg) => leg.mode === "WALK" && leg.distanceMeters === undefined),
        transfers: legs.filter((leg) => leg.tripId && !leg.inSeat).length - 1,
      };
      if (!first.routeId) return;
      releaseOfferRoute.current = useRtStore.getState().retainRoutes([first.routeId]);
      setResult({ replacement, tail, walkSaved, valid });
    } catch {
      // The optional check never interrupts active guidance.
    } finally {
      releaseDiscovery?.();
      if (!task.signal.aborted) setStatus("empty");
    }
  };

  useEffect(() => {
    if (batterySaver || !eligible || status !== "idle" || incomingDelay === undefined ||
        incomingDelay >= 0 || incomingReceivedAt === null) return;
    const check = () => {
      if (!controller.current && document.visibilityState !== "hidden" &&
          realtimeStillMatches(active, incomingDelay, Date.now(), true)) void request();
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  });

  if (!eligible || (status === "idle" && attempted.current?.itinerary === itinerary && attempted.current.index === index)) return null;

  if (result) {
    const ride = result.tail.legs[0];
    const formatTime = (value: string) => new Date(value).toLocaleTimeString(formattingLocale, {
      hour: "2-digit", minute: "2-digit", timeZone: feedTz,
    });
    return (
      <button type="button" className="w-full px-4 py-2 text-left text-accent"
        onClick={() => {
          if (result.valid()) useGuidanceStore.getState().replaceRemainingJourney(itinerary, index, result.replacement);
          releaseOfferRoute.current?.();
          releaseOfferRoute.current = null;
          setResult(undefined);
        }}>
        {t("guidance.live_transfer_take", "Take {line} toward {headsign} at {departure} · Arrive {arrival} · {minutes} min less walking")
          .replace("{line}", ride.routeShortName ?? "").replace("{headsign}", ride.headsign ?? "")
          .replace("{departure}", formatTime(ride.departureTime)).replace("{arrival}", formatTime(result.tail.arrivalTime))
          .replace("{minutes}", String(Math.floor(result.walkSaved / 60)))}
      </button>
    );
  }
  if (!batterySaver && status !== "busy") return null;
  if (status === "empty") return <p className="px-4 py-2 text-sm text-fg-muted">{t("guidance.live_transfer_none", "No verified connection found")}</p>;
  return (
    <button type="button" className="w-full px-4 py-2 text-left text-accent" disabled={status === "busy"} onClick={() => void request()}>
      {status === "busy" ? t("guidance.live_transfer_checking", "Checking live connections…")
        : t("guidance.live_transfer_check", "Check for a live connection")}
    </button>
  );
}
