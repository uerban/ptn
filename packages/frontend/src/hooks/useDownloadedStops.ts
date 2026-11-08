import { useLiveQuery } from "dexie-react-hooks";
import type { StopWithLines } from "@pt/shared";
import { db } from "../db/index.ts";
import { useCityStore } from "../stores/cityStore.ts";

const NONE: StopWithLines[] = [];

/**
 * Every stop of the active city's downloaded timetable, read locally. Nearby
 * lookups in Text mode use these instead of a map viewport, and never ask a
 * server where the user is.
 *
 * Empty while the resident bundle belongs to another city:
 * `gtfsSyncMeta.cityId` records which city `db.gtfsStops` was written for,
 * and a city switch clears it lazily.
 */
export function useDownloadedStops(): StopWithLines[] {
  const cityId = useCityStore((s) => s.activeCity.id);
  const stops = useLiveQuery(async () => {
    const meta = await db.gtfsSyncMeta.get("current");
    if (!meta || meta.cityId !== cityId) return NONE;
    const rows = await db.gtfsStops.toArray();
    return rows.map<StopWithLines>((row) => ({
      id: row.id,
      name: row.name,
      location: { lat: row.lat, lon: row.lon },
      lastSeen: meta.lastSynced,
    }));
  }, [cityId]);
  return stops ?? NONE;
}
