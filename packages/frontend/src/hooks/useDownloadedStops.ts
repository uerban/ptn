import type { StopWithLines } from "@pt/shared";
import { useCityDataQuery } from "./useCityDataQuery.ts";

const NONE: StopWithLines[] = [];

/**
 * Every stop of the active city's downloaded timetable, read locally. Nearby
 * lookups in Text mode use these instead of a map viewport, and never ask a
 * server where the user is.
 *
 * Empty while the resident timetable belongs to another city: city data reads
 * only return rows written for the active city and generation.
 */
export function useDownloadedStops(): StopWithLines[] {
  const stops = useCityDataQuery(async (data) => {
    const meta = await data.gtfsSyncMeta.get("current");
    if (!meta) return NONE;
    const rows = await data.gtfsStops.toArray();
    return rows.map<StopWithLines>((row) => ({
      id: row.id,
      name: row.name,
      location: { lat: row.lat, lon: row.lon },
      lastSeen: meta.lastSynced,
    }));
  }, []);
  return stops ?? NONE;
}
