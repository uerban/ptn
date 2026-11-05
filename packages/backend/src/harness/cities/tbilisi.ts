import type { CityProfile } from "@pt/shared";

/**
 * Static-schedule staging profile. TTC reuse terms remain unresolved; the
 * operator explicitly authorised staging activation. The existing producer
 * consumes GTFS as specified at https://gtfs.org/documentation/schedule/reference/.
 */
export const tbilisiProfile: CityProfile = {
  id: "tbilisi",
  name: "Tbilisi",
  country: "GE",
  center: { lat: 41.7151, lon: 44.8271 },
  bbox: { minLat: 41.60, minLon: 44.60, maxLat: 41.85, maxLon: 45.05 },
  agencies: ["Tbilisi Transport Company"],
  modes: ["BUS", "METRO", "AERIAL"],
  gtfsFeeds: ["https://api.transitous.org/gtfs/ge_tbilisi-transport-company.gtfs.zip"],
  gtfsRtFeeds: [],
  // Populate journey expectations from the validated feed rather than guessing
  // stop coordinates or claiming untested routing coverage.
  landmarks: [],
  searchQueries: [],
  scenarios: [],
};
