import type { Itinerary } from "@pt/shared";

const COMPARISONS = [
  ["durationSeconds", "search.fastest", "Fastest"],
  ["transfers", "search.fewest_transfers", "Fewest transfers"],
] as const;

export function routeDistinctions(
  itineraries: readonly Itinerary[],
  t: (key: string, fallback: string) => string,
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
  if (import.meta.env.VITE_PTN_DIRECT_TRADEOFF === "1") {
    const arrivals = itineraries.map((it) => it.cancelled || it.timingUnreliable || !it.legs.some((leg) => leg.tripId)
      ? NaN : Date.parse(it.arrivalTime));
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
