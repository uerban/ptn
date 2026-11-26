import type { Itinerary } from "@pt/shared";
import { useRtStore } from "../../../stores/rtStore.ts";

const COMPARISONS = [
  ["durationSeconds", "search.fastest", "Fastest"],
  ["transfers", "search.fewest_transfers", "Fewest transfers"],
] as const;

export function useRouteDistinctions(
  itineraries: readonly Itinerary[],
  t: (key: string, fallback: string) => string,
  nowMs: number,
): string[][] {
  const enabled = import.meta.env.VITE_PTN_DIRECT_TRADEOFF === "1";
  useRtStore((state) => enabled ? state.updates : null);
  return routeDistinctions(itineraries, t,
    enabled ? { nowMs, getTripDelay: useRtStore.getState().getTripDelay } : undefined);
}

export function routeDistinctions(
  itineraries: readonly Itinerary[],
  t: (key: string, fallback: string) => string,
  liveContext?: { nowMs: number; getTripDelay: ReturnType<typeof useRtStore.getState>["getTripDelay"] },
): string[][] {
  const labels = itineraries.map((): string[] => []);
  for (const [metric, key, fallback] of COMPARISONS) {
    const values = itineraries.map((it) => it.cancelled || it.timingUnreliable ? NaN : it[metric]);
    const comparable = values.filter(Number.isFinite);
    const best = Math.min(...comparable);
    // Only call out a metric that distinguishes routes in the current list.
    if (!comparable.some((value) => value > best)) continue;
    const label = t(key, fallback);
    values.forEach((value, index) => {
      if (value === best) labels[index].push(label);
    });
  }
  if (liveContext) {
    const { nowMs, getTripDelay } = liveContext;
    const arrivals = itineraries.map((it) => {
      const rides = it.legs.filter((leg) => leg.mode !== "WALK");
      const first = rides[0];
      if (it.cancelled || it.timingUnreliable || !first?.tripId) return NaN;
      const live = getTripDelay(first.tripId);
      if (live?.cancelled || live?.deleted) return NaN;
      const shift = live ? live.delaySeconds - (first.appliedDelaySeconds ?? 0) : 0;
      // A first-ride shift on a multi-ride plan may invalidate a connection
      // even if the final scheduled arrival has not changed.
      if ((rides.length > 1 && shift !== 0) || !(Date.parse(first.departureTime) + shift * 1000 > nowMs)) return NaN;
      return Date.parse(it.arrivalTime) + shift * 1000;
    });
    const earliest = Math.min(...arrivals.filter(Number.isFinite));
    const earliestDirect = Math.min(...arrivals.filter((arrival, i) => Number.isFinite(arrival) && itineraries[i].transfers === 0));
    if (Number.isFinite(earliestDirect) && earliestDirect > earliest) {
      const minutes = Math.ceil((earliestDirect - earliest) / 60_000);
      const label = t("search.direct_arrives_later", "Direct · arrives {n} min later").replace("{n}", String(minutes));
      arrivals.forEach((arrival, i) => {
        if (arrival === earliestDirect && itineraries[i].transfers === 0) labels[i].push(label);
      });
    }
  }
  return labels;
}
