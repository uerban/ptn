/**
 * How the frontend obtains the POI corpus for a city.
 *   - "eager-bundle": whole-bundle download via poiLoader (today's default).
 *   - "lazy-tile":    per-tile viewport prefetch via tileLoader (Phase 2).
 *   - "server-side":  NO corpus download; search runs against the operator's
 *                     self-hosted geocoder (nominatim/photon) via
 *                     SelfHostedGeocoderAdapter (Phase 3). The privacy option:
 * the POI corpus stays on the trusted server.
 */
export type PoiFetchMode = "eager-bundle" | "lazy-tile" | "server-side";

export const POI_FETCH_MODES = ["eager-bundle", "lazy-tile", "server-side"] as const;
