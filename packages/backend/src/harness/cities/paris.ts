import type { CityProfile } from "@pt/shared";

/**
 * Paris, France — City Test Profile
 *
 * Transit authority: IDFM (Ile-de-France Mobilites) — the regional
 * transport authority that consolidates all operators into a single
 * GTFS feed.
 *
 * Operators:
 * - RATP — metro (lines 1-14), most bus routes, tram lines (T1-T4, T6-T8)
 * - SNCF Transilien — RER (A, B, C, D, E), suburban rail (H, J, K, L, N, P, R, U)
 * - OPTILE — consortium of ~70 private bus operators in outer suburbs
 *
 * Modes: Bus, tram, metro, rail (RER + Transilien)
 * Data: Consolidated GTFS published by IDFM — updated 3x daily
 * GTFS-RT: Not available as native .pb feeds (IDFM uses SIRI Lite JSON APIs
 *   via PRIM platform, requiring API key)
 *
 * Key transit characteristics:
 * - Dense metro network (16 lines) covering central Paris
 * - RER lines providing fast cross-city rail (A: east-west, B: north-south CDG)
 * - Extensive bus network covering areas between metro stations
 * - Tram ring on former rail belt (T3a/T3b) plus suburban tram lines
 * - Major hubs: Chatelet-Les Halles (largest underground station in world),
 *   Gare du Nord (Eurostar + RER B/D), Gare de Lyon, Saint-Lazare
 * - CDG Airport connected via RER B (~35 min to center)
 * - La Defense business district connected via RER A, Metro 1, T2
 */
export const parisProfile: CityProfile = {
  id: "paris",
  name: "Paris",
  country: "FR",
  center: { lat: 48.8566, lon: 2.3522 },
  bbox: {
    minLat: 48.7500,
    minLon: 2.1500,
    maxLat: 49.0200,
    maxLon: 2.5500,
  },
  agencies: [
    "IDFM",
    "RATP",
    "SNCF Transilien",
  ],
  modes: ["BUS", "TRAM", "METRO", "RAIL"],
  gtfsFeeds: [
    // IDFM consolidated GTFS — all operators (RATP, SNCF, OPTILE)
    // Updated 3x daily, no auth required
    "https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip",
  ],
  gtfsRtFeeds: [
    // IDFM does not publish native GTFS-RT .pb feeds.
    // Real-time data available via SIRI Lite JSON APIs on PRIM
    // (requires free API key from prim.iledefrance-mobilites.fr).
  ],

  landmarks: [
    {
      name: "Chatelet-Les Halles",
      location: { lat: 48.8612, lon: 2.3470 },
      role: "largest underground station — RER A/B/D hub, Metro 1/4/7/11/14",
    },
    {
      name: "Gare du Nord",
      location: { lat: 48.8809, lon: 2.3553 },
      role: "major rail station — Eurostar, RER B/D, Metro 4/5, Transilien H/K",
    },
    {
      name: "Gare de Lyon",
      location: { lat: 48.8443, lon: 2.3735 },
      role: "major rail station — TGV south, RER A/D, Metro 1/14",
    },
    {
      name: "Gare Montparnasse",
      location: { lat: 48.8414, lon: 2.3219 },
      role: "major rail station — TGV west/southwest, Metro 4/6/12/13",
    },
    {
      name: "Gare Saint-Lazare",
      location: { lat: 48.8762, lon: 2.3250 },
      role: "suburban rail hub — Transilien J/L, Metro 3/9/12/13/14",
    },
    {
      name: "La Defense",
      location: { lat: 48.8920, lon: 2.2360 },
      role: "business district — RER A terminus, Metro 1, T2 tram",
    },
    {
      name: "CDG Airport",
      location: { lat: 49.0097, lon: 2.5479 },
      role: "Charles de Gaulle airport — RER B (~35 min to center)",
    },
    {
      name: "Nation",
      location: { lat: 48.8484, lon: 2.3960 },
      role: "major interchange — RER A, Metro 1/2/6/9",
    },
    {
      name: "Republique",
      location: { lat: 48.8675, lon: 2.3637 },
      role: "metro hub — Metro 3/5/8/9/11, central east Paris",
    },
    {
      name: "Opera",
      location: { lat: 48.8713, lon: 2.3317 },
      role: "central metro hub — Metro 3/7/8, RER A (Auber)",
    },
  ],

  searchQueries: [
    "Chatelet",
    "Gare du Nord",
    "Gare de Lyon",
    "Montparnasse",
    "Saint-Lazare",
    "La Defense",
    "Nation",
    "Republique",
    "Opera",
  ],

  geocoder: {
    kind: "self-hosted",
    endpoint: "http://localhost:8088",
    flavor: "nominatim",
    multiTenant: true,
  },

  scenarios: [
    {
      id: "gare-du-nord-to-cdg",
      description: "Airport connection: Gare du Nord to CDG Airport (RER B)",
      from: {
        name: "Gare du Nord",
        location: { lat: 48.8809, lon: 2.3553 },
        role: "major rail station",
      },
      to: {
        name: "CDG Airport",
        location: { lat: 49.0097, lon: 2.5479 },
        role: "airport",
      },
      expectModes: ["RAIL"],
      maxDurationSeconds: 3600, // 60 min max (RER B ~35 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "chatelet-to-la-defense",
      description: "East-west express: Chatelet to La Defense (RER A / Metro 1)",
      from: {
        name: "Chatelet-Les Halles",
        location: { lat: 48.8612, lon: 2.3470 },
        role: "central hub",
      },
      to: {
        name: "La Defense",
        location: { lat: 48.8920, lon: 2.2360 },
        role: "business district",
      },
      expectModes: ["METRO", "RAIL"],
      maxDurationSeconds: 2400, // 40 min max (RER A ~15 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "gare-du-nord-to-gare-de-lyon",
      description: "Station-to-station: Gare du Nord to Gare de Lyon (Metro 4+5 or RER D)",
      from: {
        name: "Gare du Nord",
        location: { lat: 48.8809, lon: 2.3553 },
        role: "major station",
      },
      to: {
        name: "Gare de Lyon",
        location: { lat: 48.8443, lon: 2.3735 },
        role: "major station",
      },
      expectModes: ["METRO", "RAIL"],
      maxDurationSeconds: 2400, // 40 min max (metro ~20 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "montparnasse-to-nation",
      description: "Cross-city metro: Montparnasse to Nation (Metro 6 direct or transfer)",
      from: {
        name: "Gare Montparnasse",
        location: { lat: 48.8414, lon: 2.3219 },
        role: "major station",
      },
      to: {
        name: "Nation",
        location: { lat: 48.8484, lon: 2.3960 },
        role: "interchange",
      },
      expectModes: ["METRO", "BUS"],
      maxDurationSeconds: 3600, // 60 min max (metro ~30 min)
      minItineraries: 1,
    },
    {
      id: "saint-lazare-to-republique",
      description: "Central metro: Saint-Lazare to Republique (short metro ride)",
      from: {
        name: "Gare Saint-Lazare",
        location: { lat: 48.8762, lon: 2.3250 },
        role: "suburban rail hub",
      },
      to: {
        name: "Republique",
        location: { lat: 48.8675, lon: 2.3637 },
        role: "metro hub",
      },
      expectModes: ["METRO"],
      maxDurationSeconds: 1800, // 30 min max (metro ~10-15 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
    {
      id: "opera-to-chatelet",
      description: "Short center trip: Opera to Chatelet (Metro 7 direct, ~5 min)",
      from: {
        name: "Opera",
        location: { lat: 48.8713, lon: 2.3317 },
        role: "central hub",
      },
      to: {
        name: "Chatelet-Les Halles",
        location: { lat: 48.8612, lon: 2.3470 },
        role: "central hub",
      },
      expectModes: ["METRO", "WALK"],
      maxDurationSeconds: 1200, // 20 min max (metro ~5 min or walkable ~15 min)
      minItineraries: 1,
      expectsTransfer: false,
    },
  ],
};
