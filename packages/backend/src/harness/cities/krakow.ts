import type { CityProfile } from "@pt/shared";

/**
 * Krakow, Poland — City Test Profile
 *
 * Transit operator: MPK Krakow (Miejskie Przedsiebiorstwo Komunikacyjne S.A.)
 * managed by ZTP Krakow (Zarzad Transportu Publicznego w Krakowie).
 *
 * Operators:
 * - MPK Krakow — buses, trams, trolleybuses
 *
 * Modes: Bus, tram, trolleybus
 * Data: GTFS feeds published by ZTP Krakow — three feeds merged at backend:
 *   GTFS_KRK_A.zip (buses), GTFS_KRK_M.zip (trams), GTFS_KRK_T.zip (trolleybuses).
 *   Each feed uses disjoint ID namespaces; no collisions expected.
 * GTFS-RT: Vehicle positions + trip updates published per-mode separately.
 *
 * Key transit characteristics:
 * - Extensive tram network through city center (Nowa Huta, Bronowice, Kurdwanow)
 * - Bus network covering suburbs and areas without tram coverage
 * - Krakow Glowny is the main rail station and transit hub
 * - Balice airport connected by rail (separate Koleje Malopolskie feed) and bus (292, 208)
 * - Tram network has multiple lines crossing the Old Town ring
 * - Major hubs: Krakow Glowny, Rondo Grzegorzeckie, Rondo Mogilskie, Nowy Kleparz
 */
export const krakowProfile: CityProfile = {
  id: "krakow",
  name: "Krakow",
  country: "PL",
  center: { lat: 50.0647, lon: 19.9450 },
  bbox: {
    minLat: 49.9700,
    minLon: 19.7700,
    maxLat: 50.1300,
    maxLon: 20.1700,
  },
  agencies: [
    "MPK Krakow",
  ],
  modes: ["BUS", "TRAM", "TROLLEYBUS"],
  gtfsFeeds: [
    // ZTP Krakow buses (A = Autobusy)
    "https://gtfs.ztp.krakow.pl/GTFS_KRK_A.zip",
    // ZTP Krakow trams (M = traMwaje)
    "https://gtfs.ztp.krakow.pl/GTFS_KRK_M.zip",
    // ZTP Krakow trolleybuses (T = Trolejbusy)
    "https://gtfs.ztp.krakow.pl/GTFS_KRK_T.zip",
  ],
  gtfsRtFeeds: [
    // ZTP Krakow bus vehicle positions + trip updates
    "https://gtfs.ztp.krakow.pl/VehiclePositions_A.pb",
    "https://gtfs.ztp.krakow.pl/TripUpdates_A.pb",
    // ZTP Krakow tram vehicle positions + trip updates
    "https://gtfs.ztp.krakow.pl/VehiclePositions_M.pb",
    "https://gtfs.ztp.krakow.pl/TripUpdates_M.pb",
    // ZTP Krakow trolleybus vehicle positions + trip updates
    "https://gtfs.ztp.krakow.pl/VehiclePositions_T.pb",
    "https://gtfs.ztp.krakow.pl/TripUpdates_T.pb",
  ],

  landmarks: [
    {
      name: "Krakow Glowny",
      location: { lat: 50.0677, lon: 19.9467 },
      role: "main train station — major transit hub, tram and bus interchange",
    },
    {
      name: "Rynek Glowny",
      location: { lat: 50.0616, lon: 19.9373 },
      role: "Main Market Square — Old Town center, tourist hub",
    },
    {
      name: "Kazimierz",
      location: { lat: 50.0510, lon: 19.9460 },
      role: "historic Jewish quarter — tram and bus connections",
    },
    {
      name: "Nowa Huta",
      location: { lat: 50.0725, lon: 20.0375 },
      role: "eastern district — tram terminus, large residential area",
    },
    {
      // Coordinates are the ZTP stop `pl-ZTP-Kraków-A_11470` (feed
      // GTFS_KRK_A.zip, already listed below), NOT the terminal centroid. The
      // old point 50.0778,19.7848 sat ~1.3 km from the airport transit complex,
      // in a dead zone whose only indexed feature is a flight-feed stop
      // ("Aeroporto di Cracovia/Krakow (KRK)") carrying no ground-transit
      // trips — so every plan from it returned zero. Reverse-geocode cannot
      // reveal that: it ignores `radius` and returns only the ~5 nearest
      // features of any type, so a dead point looks just like a correct one.
      name: "Balice Airport",
      location: { lat: 50.07163, lon: 19.80018 },
      role: "John Paul II International Airport — bus 300 + SKA1 rail to centre",
    },
    {
      name: "Rondo Grzegorzeckie",
      location: { lat: 50.0589, lon: 19.9580 },
      role: "major tram interchange — east of Old Town",
    },
    {
      name: "Nowy Kleparz",
      location: { lat: 50.0710, lon: 19.9410 },
      role: "bus terminal — north of station, regional bus connections",
    },
    {
      name: "Kurdwanow",
      location: { lat: 50.0150, lon: 19.9650 },
      role: "southern tram terminus — P+R park and ride",
    },
    {
      name: "Bronowice",
      location: { lat: 50.0780, lon: 19.8960 },
      role: "western district — tram terminus, Bronowice Male loop",
    },
    {
      name: "Rondo Mogilskie",
      location: { lat: 50.0645, lon: 19.9600 },
      role: "major tram/bus hub — Mogilskie roundabout, east-west junction",
    },
  ],

  searchQueries: [
    "Krakow Glowny",
    "Rynek Glowny",
    "Kazimierz",
    "Nowa Huta",
    "Kurdwanow",
    "Bronowice",
    "Rondo Mogilskie",
    "Nowy Kleparz",
  ],

  geocoder: {
    kind: "self-hosted",
    endpoint: "http://localhost:8088",
    flavor: "nominatim",
    multiTenant: true,
  },

  scenarios: [
    {
      id: "station-to-old-town",
      description: "Short center trip: Krakow Glowny to Rynek Glowny (Main Square)",
      from: {
        name: "Krakow Glowny",
        location: { lat: 50.0677, lon: 19.9467 },
        role: "main station",
      },
      to: {
        name: "Rynek Glowny",
        location: { lat: 50.0616, lon: 19.9373 },
        role: "main square",
      },
      expectModes: ["WALK"],
      // Bounds the WALK (the test asserts on `direct`, not on the fastest
      // journey overall). Upstream routes this pair at a stable 1288 s, so:
      // measured walk +~40%, rounded to the nearest 5 min = 1800.
      //
      // The previous 1200 came from the real-world walk (~10 min for ~950 m),
      // which upstream does not reproduce — 1288 s was already over it, so the
      // assertion passed only when some transit option happened to beat 20 min
      // and went red when none did.
      maxDurationSeconds: 1800,
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "station-to-nowa-huta",
      description: "Cross-city tram: Krakow Glowny to Nowa Huta (tram 4/10/22)",
      from: {
        name: "Krakow Glowny",
        location: { lat: 50.0677, lon: 19.9467 },
        role: "main station",
      },
      to: {
        name: "Nowa Huta",
        location: { lat: 50.0725, lon: 20.0375 },
        role: "eastern district",
      },
      expectModes: ["TRAM", "BUS"],
      maxDurationSeconds: 3600, // 60 min max (tram ~30-40 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "airport-to-center",
      description: "Airport to Krakow Glowny (bus 208/292 or rail)",
      from: {
        // Keep in step with the Balice Airport landmark above — same stop,
        // same coordinate. The landmark drives the nearby-stops probe and this
        // drives the plan query; if they drift apart one of them goes back to
        // probing the dead point without anything failing to say so.
        name: "Balice Airport",
        location: { lat: 50.07163, lon: 19.80018 },
        role: "airport",
      },
      to: {
        name: "Krakow Glowny",
        location: { lat: 50.0677, lon: 19.9467 },
        role: "main station",
      },
      expectModes: ["BUS", "RAIL"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
    },
    {
      id: "tram-north-south",
      description: "North-south tram: Bronowice to Kurdwanow (tram cross-city)",
      from: {
        name: "Bronowice",
        location: { lat: 50.0780, lon: 19.8960 },
        role: "western tram terminus",
      },
      to: {
        name: "Kurdwanow",
        location: { lat: 50.0150, lon: 19.9650 },
        role: "southern tram terminus",
      },
      expectModes: ["TRAM", "BUS"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
      expectsTransfer: true,
    },
    {
      id: "kazimierz-to-nowa-huta",
      description: "East-bound: Kazimierz to Nowa Huta via tram",
      from: {
        name: "Kazimierz",
        location: { lat: 50.0510, lon: 19.9460 },
        role: "historic quarter",
      },
      to: {
        name: "Nowa Huta",
        location: { lat: 50.0725, lon: 20.0375 },
        role: "eastern district",
      },
      expectModes: ["TRAM", "BUS"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
    },
    {
      id: "rondo-to-rondo",
      description: "Hub-to-hub: Rondo Mogilskie to Rondo Grzegorzeckie (adjacent hubs)",
      from: {
        name: "Rondo Mogilskie",
        location: { lat: 50.0645, lon: 19.9600 },
        role: "transit hub",
      },
      to: {
        name: "Rondo Grzegorzeckie",
        location: { lat: 50.0589, lon: 19.9580 },
        role: "transit hub",
      },
      expectModes: ["TRAM", "WALK"],
      maxDurationSeconds: 1200, // 20 min max (very short)
      minItineraries: 1,
      expectsTransfer: false,
    },
  ],
};
