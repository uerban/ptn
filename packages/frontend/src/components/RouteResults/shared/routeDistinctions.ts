import type { Itinerary } from "@pt/shared";

const COMPARISONS = [
  ["durationSeconds", "search.fastest", "Fastest"],
  ["transfers", "search.fewest_transfers", "Fewest transfers"],
  ["walkingDistanceMeters", "search.least_walking", "Least walking"],
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
  return labels;
}
