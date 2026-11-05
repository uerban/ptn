/**
 * Reference URL used by the route-overlay e2e specs (Phase 1, Tasks 26-27).
 *
 * Target: Šeškinės poliklinika → Europos aikštė — the shaped Vilnius itinerary
 * exercised during live RAPTOR verification.
 *
 * The mock-api harness now ships a Vilnius-shaped `raptor-data.json` fixture
 * (route 3G with a shape manifest) and serves a `shapes.json` artifact at the
 * hashed URL, and `Search.tsx` resolves `fromStopId` / `toStopId` query params
 * against the local GTFS stops table. Together these drive the app from the
 * REF_URL through auto-search → itinerary pick → guidance mode, where
 * `RouteOverlay` (and `guidance-leg-0`) is mounted.
 */
export const REF_URL =
  "/search?fromStopId=vilnius-seskinespoliklinika&toStopId=vilnius-europosaikste";

/**
 * Stop-ID query pair (no leading path / `?`) reusable across non-route-overlay
 * specs (e.g. wasm-engine specs that drive the same auto-search code path but
 * navigate to `/` with extra query flags). Mirrors REF_URL's
 * Vilnius-shaped fixture pair.
 */
export const REF_STOP_QUERY =
  "fromStopId=vilnius-seskinespoliklinika&toStopId=vilnius-europosaikste";

/** Deterministic clock pinned to Vilnius mid-day so daytime trips are reachable. */
export const REF_FIXED_TIME = new Date("2026-04-22T12:00:00+03:00");
