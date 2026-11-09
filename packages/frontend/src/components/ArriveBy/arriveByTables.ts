/**
 * The stop and route tables the opt-in Arrive-by search reads, kept for the
 * RAPTOR index and init generation they were read under (H73 step 2), so
 * Apply reuses what the H75 warm-up read instead of reading 1,552 stops and
 * every route from IndexedDB again (about 110 ms and 22–37 ms on the phone).
 *
 * Only `gtfsSync` writes these tables. Every sync and every `reset` runs inside
 * a new init generation (`gtfsDataStore` `init`, `refresh`, `reset`), a sync
 * then installs a new index, and nothing read while `syncing` is kept. So a
 * kept table is always the rows a fresh read would return. The normal
 * planner reads its own.
 */
import { captureCityData } from "../../services/cityData.ts";
import type { RaptorIndex } from "../../services/raptorIndex.ts";
import type { SearchConfig } from "../../services/searchOrchestrator.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import type { ArriveByStop } from "./arriveByItineraries.ts";

/** What the planner reads of a row; the kept rows are the whole records. */
type StopRow = SearchConfig["allStops"][number];

export interface ArriveByStopTable {
  /** The rows as `db.gtfsStops.toArray()` returned them. Never mutated. */
  readonly rows: readonly StopRow[];
  readonly lookup: ReadonlyMap<string, ArriveByStop>;
}

/** One kept read per index and init generation; a failed read is not kept. */
function keptPerIndex<T>(read: () => Promise<T>): () => Promise<T> {
  let entry: { index: RaptorIndex; generation: number; value: Promise<T> } | null = null;
  return () => {
    const { raptorIndex, syncing, getInitGeneration } = useGtfsDataStore.getState();
    const generation = getInitGeneration();
    if (entry && entry.index === raptorIndex && entry.generation === generation && !syncing) return entry.value;
    const value = read();
    if (raptorIndex && !syncing) {
      const mine = { index: raptorIndex, generation, value };
      entry = mine;
      value.catch(() => { if (entry === mine) entry = null; });
    } else {
      entry = null;
    }
    return value;
  };
}

export const arriveByStopTable = keptPerIndex(async (): Promise<ArriveByStopTable> => {
  const rows = await captureCityData().gtfsStops.toArray();
  return { rows, lookup: new Map(rows.map((s) => [s.id, { name: s.name, lat: s.lat, lon: s.lon }])) };
});

/** routeId → colour, for rides that carry none. */
export const arriveByRouteColors = keptPerIndex(async (): Promise<ReadonlyMap<string, string>> => {
  const colors = new Map<string, string>();
  for (const r of await captureCityData().gtfsRoutes.toArray()) if (r.color) colors.set(r.id, r.color);
  return colors;
});
