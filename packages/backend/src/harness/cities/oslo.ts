import type { CityProfile } from "@pt/shared";

/**
 * Oslo, Norway — City Test Profile
 *
 * Transit authority: Ruter AS — public PTA covering Oslo + the
 * surrounding Akershus region (formerly Oslo + Akershus county; merged
 * into Viken 2020-2024, split back). Ruter contracts vehicle operations
 * to Sporveien (T-bane + tram + most buses), Unibuss, Norgesbuss, and
 * others under a unified Ruter brand and ticketing.
 *
 * Operators (Ruter contract):
 * - Sporveien T-banen — 5 metro lines (1-5) sharing the Fellestunnelen
 *   between Majorstuen and Tøyen, branching outward at each end
 * - Sporveien Trikken — 6 tram lines (11, 12, 13, 17, 18, 19) on
 *   ~135 km of city-centre streetcar
 * - Sporveien Buss / Unibuss / Norgesbuss / Nettbuss — bus network
 *   covering everything outside metro/tram coverage
 * - Norled / Ruter ferries — fjord ferries to Hovedøya, Bygdøy,
 *   Nesoddtangen, etc.
 *
 * Long-distance rail in the Oslo area is run by Vy (state operator) and
 * Flytoget (airport express); these are NOT in the Ruter feed below.
 * Their tickets are honoured on Ruter local services within zone 1, but
 * their schedules are published in Entur's separate per-operator
 * GTFS feeds.
 *
 * Modes: BUS, TRAM, METRO, FERRY (rail via separate feed if needed)
 *
 * Data:
 * - Static GTFS published by Entur (the Norwegian national PTA data
 *   coordinator) at a stable Google Cloud Storage URL. Updated daily
 *   ~04:00 Europe/Oslo. No auth required for the static feed.
 * - The "rb_rut-aggregated-gtfs.zip" feed contains exactly the Ruter
 *   network (bus + tram + metro + ferry). Use the Norway-aggregated
 *   feed instead if rail is needed; see GTFS_STATIC_URL_OSLO override
 *   in docker-compose.yml.
 * - GTFS-RT trip updates and vehicle positions are exposed by Entur at
 *   api.entur.io — but they require an `ET-Client-Name` header that
 *   identifies the consumer. We don't ship a default value (no
 *   anonymous default acceptable to Entur's terms), so RT is empty here.
 *   Operators who want RT should set GTFS_RT_TRIP_UPDATES_URL_OSLO with
 *   a feed they're authorised to consume and add the header via
 *   GTFS_RT_HEADERS.
 *
 * Key transit characteristics:
 * - Common-tunnel T-bane: all 5 metro lines share the central
 *   Majorstuen → Tøyen tunnel before branching, so transfers between
 *   any two lines through the city centre are cross-platform.
 * - Tram ring through downtown (lines 11/12/13/17/18/19) connects most
 *   central districts that aren't on the T-bane.
 * - Oslo S (Central Station) is the multi-modal hub: T-bane, tram, all
 *   regional bus, Vy regional rail, Flytoget airport express.
 * - Gardermoen Airport (OSL, ~50 km north) connects via Flytoget
 *   (~22 min, premium) or Vy regional rail (~25 min, Ruter-zoned) — both
 *   from Oslo S. Out-of-area for Ruter-only routing; included as a
 *   landmark for geocoder coverage and operator override.
 * - Major hubs: Oslo S, Nationaltheatret, Stortinget, Majorstuen,
 *   Carl Berners plass, Jernbanetorget.
 * - Norwegian diacritics in stop names — Tøyen exercises ø through the
 *   search path, useful for Unicode coverage alongside Lithuanian
 *   (Vilnius) and Polish (Tricity, Krakow). Add stops with æ or å
 *   (e.g., Bærum, Skøyen) when widening to Akershus suburbs.
 */
export const osloProfile: CityProfile = {
  id: "oslo",
  name: "Oslo",
  country: "NO",
  center: { lat: 59.9139, lon: 10.7522 },
  // bbox covers the Oslo built-up area plus the western suburb corridor
  // (Lysaker, Sandvika, Asker — all within Ruter zone 1/2 and on the
  // common-tunnel rail line) and extends east past the ring road. Does
  // NOT include Gardermoen Airport (60.19, 11.10) — the airport is
  // out-of-area for Ruter and reaching it requires Vy / Flytoget rail
  // which is in a separate operator feed. The airport is listed as a
  // landmark for completeness; users routing TO the airport via
  // Ruter alone get a "no service" response, which is correct. Set
  // GTFS_STATIC_URL_OSLO to the Norway-aggregated feed and widen this
  // bbox if you want to serve airport routing from this backend.
  bbox: {
    minLat: 59.8000,
    minLon: 10.4000,
    maxLat: 60.0500,
    maxLon: 11.0000,
  },
  agencies: [
    "Ruter",
    "Sporveien",
  ],
  modes: ["BUS", "TRAM", "METRO", "FERRY"],
  gtfsFeeds: [
    // Entur — Ruter (RUT) aggregated feed: bus + tram + metro + ferry
    // for Oslo + Akershus. Updated daily ~04:00 Europe/Oslo. No auth.
    "https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_rut-aggregated-gtfs.zip",
  ],
  gtfsRtFeeds: [
    // Entur publishes RT at api.entur.io but requires an ET-Client-Name
    // header — see profile JSDoc. Empty by default; set
    // GTFS_RT_TRIP_UPDATES_URL_OSLO + GTFS_RT_HEADERS in your env.
  ],

  landmarks: [
    {
      name: "Oslo S",
      location: { lat: 59.9111, lon: 10.7530 },
      role: "central station — Vy regional rail, Flytoget, T-bane, tram, regional bus hub",
    },
    {
      name: "Nationaltheatret",
      location: { lat: 59.9145, lon: 10.7359 },
      role: "central T-bane (Fellestunnelen) + Vy local rail station — also west portal of the Oslotunnelen rail tunnel",
    },
    {
      name: "Stortinget",
      location: { lat: 59.9132, lon: 10.7401 },
      role: "central T-bane interchange — common-tunnel station between Oslo S and Nationaltheatret",
    },
    {
      name: "Jernbanetorget",
      location: { lat: 59.9118, lon: 10.7508 },
      role: "tram + bus hub adjacent to Oslo S — primary surface-transit interchange",
    },
    {
      name: "Majorstuen",
      location: { lat: 59.9292, lon: 10.7142 },
      role: "T-bane interchange — west branch point for lines 1-5, also tram 11/19",
    },
    {
      name: "Tøyen",
      location: { lat: 59.9125, lon: 10.7745 },
      role: "T-bane east-branch point — Munch Museum + university campus",
    },
    {
      name: "Carl Berners plass",
      location: { lat: 59.9255, lon: 10.7826 },
      role: "ring-line interchange — tram 17 + bus hub, north-east of centre",
    },
    {
      name: "Aker Brygge",
      location: { lat: 59.9099, lon: 10.7280 },
      role: "fjord-side ferry hub — Nesoddtangen + Hovedøya + Bygdøy connections",
    },
    {
      name: "Lysaker",
      location: { lat: 59.9135, lon: 10.6371 },
      role: "western suburb — major rail + bus interchange on the Drammen line",
    },
    {
      name: "Sandvika",
      location: { lat: 59.8917, lon: 10.5274 },
      role: "western Akershus hub — regional rail, intercity bus, Bærum centre",
    },
    // Gardermoen Airport (60.1939, 11.1004) deliberately omitted: it
    // is not in the Ruter feed and not in the bbox, so listing it as
    // a landmark would either weaken the wrong-city bbox validator
    // (by enlarging the envelope) or trip the registry-level
    // landmark-in-bbox test. To route to OSL, switch this backend's
    // GTFS feed to rb_norway-aggregated-gtfs.zip and widen the bbox.
  ],

  searchQueries: [
    "Oslo S",
    "Nationaltheatret",
    "Majorstuen",
    "Tøyen",
    "Aker Brygge",
    "Carl Berners plass",
    "Jernbanetorget",
    "Lysaker",
  ],

  geocoder: {
    kind: "self-hosted",
    endpoint: "http://localhost:8088",
    flavor: "nominatim",
    multiTenant: true,
  },

  scenarios: [
    {
      id: "oslos-to-majorstuen",
      description: "Cross-centre T-bane: Oslo S to Majorstuen (any line through common tunnel)",
      from: {
        name: "Oslo S",
        location: { lat: 59.9111, lon: 10.7530 },
        role: "central station",
      },
      to: {
        name: "Majorstuen",
        location: { lat: 59.9292, lon: 10.7142 },
        role: "T-bane west interchange",
      },
      expectModes: ["METRO"],
      maxDurationSeconds: 1800,
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "oslos-to-aker-brygge",
      description: "Short hop to fjord: Oslo S to Aker Brygge (tram 12 or short walk)",
      from: {
        name: "Oslo S",
        location: { lat: 59.9111, lon: 10.7530 },
        role: "central station",
      },
      to: {
        name: "Aker Brygge",
        location: { lat: 59.9099, lon: 10.7280 },
        role: "fjord-side hub",
      },
      expectModes: ["TRAM", "WALK"],
      maxDurationSeconds: 1500,
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "toyen-to-carl-berners",
      description: "East-side ring: Tøyen to Carl Berners plass (tram 17 or bus 20/21)",
      from: {
        name: "Tøyen",
        location: { lat: 59.9125, lon: 10.7745 },
        role: "T-bane east branch",
      },
      to: {
        name: "Carl Berners plass",
        location: { lat: 59.9255, lon: 10.7826 },
        role: "ring-line interchange",
      },
      expectModes: ["TRAM", "BUS", "METRO"],
      maxDurationSeconds: 1800,
      minItineraries: 1,
    },
    {
      id: "sandvika-to-oslos",
      description: "Western suburb commute: Sandvika to Oslo S (express bus 110 or regional bus + transfer)",
      from: {
        name: "Sandvika",
        location: { lat: 59.8917, lon: 10.5274 },
        role: "Bærum suburb hub",
      },
      to: {
        name: "Oslo S",
        location: { lat: 59.9111, lon: 10.7530 },
        role: "central station",
      },
      expectModes: ["BUS", "METRO"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
    },
    {
      id: "oslos-to-lysaker",
      description: "West corridor: Oslo S to Lysaker (bus 31 / express via Skøyen)",
      from: {
        name: "Oslo S",
        location: { lat: 59.9111, lon: 10.7530 },
        role: "central station",
      },
      to: {
        name: "Lysaker",
        location: { lat: 59.9135, lon: 10.6371 },
        role: "western interchange",
      },
      expectModes: ["BUS", "METRO"],
      maxDurationSeconds: 2400,
      minItineraries: 1,
    },
    {
      id: "majorstuen-to-toyen",
      description: "Common-tunnel test: Majorstuen to Tøyen (any T-bane line, end-to-end of shared core)",
      from: {
        name: "Majorstuen",
        location: { lat: 59.9292, lon: 10.7142 },
        role: "T-bane west branch",
      },
      to: {
        name: "Tøyen",
        location: { lat: 59.9125, lon: 10.7745 },
        role: "T-bane east branch",
      },
      expectModes: ["METRO"],
      maxDurationSeconds: 1500,
      minItineraries: 1,
      expectsTransfer: false,
    },
  ],
};
