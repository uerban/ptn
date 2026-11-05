import type { CityProfile } from "@pt/shared";

/**
 * Trójmiasto (Tricity), Poland — City Test Profile
 *
 * The Tricity metro area consists of Gdańsk, Sopot, and Gdynia stretching
 * ~30km along the coast. Multiple transit operators serve the area:
 *
 * Operators:
 * - ZTM Gdańsk — buses and trams in Gdańsk
 * - ZKM Gdynia — buses and trolleybuses in Gdynia
 * - PKM (Pomorska Kolej Metropolitalna) — metropolitan commuter rail
 * - SKM Trójmiasto — Szybka Kolej Miejska, fast urban rail along the coast
 *
 * Modes: Bus, tram (Gdańsk), trolleybus (Gdynia), commuter rail (SKM, PKM)
 *
 * This is a key Jakdojade market — the Polish transit app covers Tricity
 * extensively. Testing against Tricity validates multi-operator trip planning
 * and cross-city rail integration (SKM Gdańsk↔Gdynia), which is a scenario
 * where users have reported Jakdojade ticket-type confusion.
 *
 * Key transit characteristics:
 * - SKM coastal rail is the backbone (Gdańsk Główny ↔ Sopot ↔ Gdynia Główna)
 * - PKM provides inland rail connections (opened 2015, airport line)
 * - Tram network in central Gdańsk (Wrzeszcz, Oliwa, Stogi, Nowy Port)
 * - Gdynia has trolleybuses instead of trams
 * - Airport served by PKM rail + bus
 * - Multi-operator transfers are common and a known UX pain point
 */
export const tricityProfile: CityProfile = {
  id: "tricity",
  name: "Trójmiasto (Tricity)",
  country: "PL",
  center: { lat: 54.3520, lon: 18.6466 },
  bbox: {
    minLat: 54.2800,
    minLon: 18.4500,
    maxLat: 54.5400,
    maxLon: 18.8500,
  },
  agencies: [
    "ZTM Gdańsk",
    "ZKM Gdynia",
    "SKM Trójmiasto",
    "PKM",
  ],
  modes: ["BUS", "TRAM", "RAIL"],
  gtfsFeeds: [
    // ZTM Gdańsk (buses + trams) — Transitland: f-ztm~gdansk
    "https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/30e783e4-2bec-4a7d-bb22-ee3e3b26ca96/download/gtfsgoogle.zip",
    // ZKM Gdynia (buses + trolleybuses) — Transitland: f-ztm~gdynia
    "http://api.zdiz.gdynia.pl/pt/gtfs.zip",
    // SKM Trójmiasto (commuter rail) — Transitland: f-u3t-skm~trojmiasto
    "https://www.skm.pkp.pl/gtfs-mi-kpd.zip",
  ],
  gtfsRtFeeds: [
    // ZTM Gdańsk GTFS-RT (trip updates + vehicle positions)
    "http://ckan2.multimediagdansk.pl/gtfs-rt",
    // ZTM Gdańsk vehicle positions only
    "http://ckan2.multimediagdansk.pl/gtfs-rt?feed=vehiclePositions",
    // SKM Trójmiasto GTFS-RT (community-provided, CC BY 4.0)
    "https://gtfs.kasznia.net/rt/skmt.pb",
  ],

  landmarks: [
    {
      name: "Gdańsk Główny",
      location: { lat: 54.3560, lon: 18.6440 },
      stopId: "pl-PKP-SKM_7500",
      role: "main train station — SKM, PKM, regional rail hub",
    },
    {
      name: "Gdańsk Wrzeszcz",
      location: { lat: 54.3820, lon: 18.6051 },
      role: "major SKM station — university area, tram interchange, PKM junction",
    },
    {
      name: "Gdańsk Oliwa",
      location: { lat: 54.4095, lon: 18.5719 },
      role: "SKM station — residential, Oliwa Cathedral",
    },
    {
      name: "Długi Targ",
      location: { lat: 54.3483, lon: 18.6540 },
      role: "Old Town — tourist center, Long Market",
    },
    {
      name: "Sopot",
      location: { lat: 54.4401, lon: 18.5623 },
      role: "Sopot SKM station — seaside resort town",
    },
    {
      name: "Gdynia Główna",
      location: { lat: 54.5209, lon: 18.5293 },
      stopId: "pl-PKP-SKM_5900",
      role: "Gdynia main station — SKM terminus, trolleybus hub",
    },
    {
      name: "Port Lotniczy Gdańsk",
      location: { lat: 54.3827, lon: 18.4668 },
      stopId: "pl-PKP-SKM_257530",
      role: "Gdańsk Lech Wałęsa Airport — PKM rail station",
    },
    {
      name: "Chełm Witosa",
      location: { lat: 54.3377, lon: 18.6178 },
      stopId: "pl-Gdańsk_2219",
      role: "southern tram terminus — Gdańsk Południe hub",
    },
    {
      name: "Zaspa",
      location: { lat: 54.3900, lon: 18.5914 },
      role: "SKM station — residential, between Wrzeszcz and Oliwa",
    },
    {
      name: "Nowy Port",
      location: { lat: 54.3966, lon: 18.6701 },
      role: "tram terminus — northern waterfront",
    },
  ],

  searchQueries: [
    "Gdańsk Główny",
    "Gdynia Główna",
    "Sopot",
    "Wrzeszcz",
    "Oliwa",
    "Długi Targ",
    "Zaspa",
    "Lotnisko",
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
      description: "Short center trip: Gdańsk Główny to Old Town (Długi Targ)",
      from: {
        name: "Gdańsk Główny",
        location: { lat: 54.3557, lon: 18.6442 },
        role: "main station",
      },
      to: {
        name: "Długi Targ",
        location: { lat: 54.3482, lon: 18.6533 },
        role: "old town",
      },
      expectModes: ["WALK"],
      // Bounds the WALK (the test asserts on `direct`). Same rule as Krakow's
      // station-to-old-town: upstream routes this pair at a stable 1104 s, so
      // measured walk +~40%, rounded to the nearest 5 min = 1500. The former
      // 1800 was not wrong, just slack enough at 63% over the walk that it
      // could not have caught a real upstream regression.
      maxDurationSeconds: 1500,
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "gdansk-to-gdynia",
      description: "Cross-Tricity rail: Gdańsk Główny to Gdynia Główna (SKM)",
      from: {
        name: "Gdańsk Główny",
        location: { lat: 54.3557, lon: 18.6442 },
        role: "Gdańsk main station",
      },
      to: {
        name: "Gdynia Główna",
        location: { lat: 54.5206, lon: 18.5313 },
        role: "Gdynia main station",
      },
      expectModes: ["RAIL"],
      maxDurationSeconds: 3600, // 60 min max (SKM takes ~35 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "airport-to-center",
      description: "Airport to Gdańsk Główny (PKM rail connection)",
      from: {
        name: "Port Lotniczy",
        location: { lat: 54.3776, lon: 18.4662 },
        role: "airport",
      },
      to: {
        name: "Gdańsk Główny",
        location: { lat: 54.3557, lon: 18.6442 },
        role: "main station",
      },
      expectModes: ["RAIL", "BUS"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
    },
    {
      id: "tram-cross-gdansk",
      description: "Tram route within Gdańsk: Nowy Port to Gdańsk Południe",
      from: {
        name: "Nowy Port",
        location: { lat: 54.3966, lon: 18.6701 },
        role: "tram terminus north",
      },
      to: {
        name: "Gdańsk Południe",
        location: { lat: 54.3245, lon: 18.6293 },
        role: "south Gdańsk",
      },
      expectModes: ["TRAM", "BUS"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
      expectsTransfer: true,
    },
    {
      id: "multi-operator-transfer",
      description: "Multi-operator: Gdańsk tram area to Gdynia trolleybus area (ZTM→SKM→ZKM)",
      from: {
        name: "Gdańsk Wrzeszcz",
        location: { lat: 54.3809, lon: 18.5997 },
        role: "tram/SKM interchange",
      },
      to: {
        name: "Gdynia Główna",
        location: { lat: 54.5206, lon: 18.5313 },
        role: "trolleybus hub",
      },
      expectModes: ["RAIL"],
      maxDurationSeconds: 3600,
      minItineraries: 1,
      expectsTransfer: false, // Direct SKM possible
    },
    {
      id: "sopot-detour",
      description: "Sopot to Oliwa — short SKM hop between two beach towns",
      from: {
        name: "Sopot",
        location: { lat: 54.4416, lon: 18.5598 },
        role: "resort town",
      },
      to: {
        name: "Gdańsk Oliwa",
        location: { lat: 54.4103, lon: 18.5563 },
        role: "Oliwa district",
      },
      expectModes: ["RAIL"],
      maxDurationSeconds: 1800,
      minItineraries: 1,
      expectsTransfer: false,
    },
  ],
};
