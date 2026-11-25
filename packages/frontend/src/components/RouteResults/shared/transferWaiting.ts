import type { Itinerary } from "@pt/shared";
import type { ItineraryDisplay } from "./itineraryDisplay.ts";

export function transferWaitingSeconds(itinerary: Itinerary, display: Pick<ItineraryDisplay, "firstTransitDepartureMs" | "catchStatus">): number | null {
  if (!itinerary.transfers || itinerary.cancelled || itinerary.timingUnreliable ||
    display.catchStatus === "cancelled" || display.catchStatus === "removed") return null;

  let previousArrival: number | undefined;
  let walkingMs = 0;
  let waitingMs = 0;
  let transfers = 0;
  for (const leg of itinerary.legs) {
    const departure = Date.parse(leg.departureTime);
    const arrival = Date.parse(leg.arrivalTime);
    if (!(arrival >= departure)) return null;
    if (leg.mode === "WALK") {
      if (previousArrival !== undefined) walkingMs += arrival - departure;
      continue;
    }

    if (previousArrival === undefined) {
      const delta = display.firstTransitDepartureMs - departure;
      if (!Number.isFinite(delta)) return null;
      previousArrival = arrival + delta;
      continue;
    }

    const gap = departure - previousArrival - walkingMs;
    if (gap < 0) return null;
    if (!leg.inSeat) {
      waitingMs += gap;
      transfers++;
    }
    walkingMs = 0;
    previousArrival = arrival;
  }
  return transfers === itinerary.transfers ? waitingMs / 1000 : null;
}

export function transferWaitingLabel(itinerary: Itinerary, display: ItineraryDisplay,
  t: (key: string, fallback?: string) => string): string | null {
  if (import.meta.env.VITE_PTN_TRANSFER_WAIT_COMPARISON !== "1") return null;
  const seconds = transferWaitingSeconds(itinerary, display);
  if (seconds === null) return null;
  if (seconds > 0 && seconds < 60) return t("route.transfer_wait_under_minute", "Under 1 min between vehicles");
  return t("route.transfer_wait_minutes", "{n} min waiting between vehicles")
    .replace("{n}", String(Math.round(seconds / 60)));
}
