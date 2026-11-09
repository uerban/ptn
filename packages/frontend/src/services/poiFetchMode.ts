import { POI_FETCH_MODES, type PoiFetchMode } from "@pt/shared/poi";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { CITIES, type CityConfig } from "../config/cities.ts";
import { canUse } from "../privacy/canUse.ts";

function isPoiFetchMode(x: unknown): x is PoiFetchMode {
  return typeof x === "string" && (POI_FETCH_MODES as readonly string[]).includes(x);
}

/**
 * Operator default from build/runtime config. Validates VITE_PT_POI_FETCH_MODE against
 * POI_FETCH_MODES so an operator can set ANY valid member ("lazy-tile", "server-side", or
 * "eager-bundle"); an invalid/absent value falls back to "eager-bundle". Rungs 3 and 4 of
 * resolveRawPoiFetchMode both resolve inside this one function.
 */
function operatorDefault(): PoiFetchMode {
  const v = import.meta.env.VITE_PT_POI_FETCH_MODE;
  return isPoiFetchMode(v) ? v : "eager-bundle";
}

/** Per-city operator override (rung 2 — see resolveRawPoiFetchMode's JSDoc for the
 *  full ordering). Reads CityConfig.poiFetchMode for the city. The `cities` list
 *  is injected (defaulted to CITIES) so this helper is unit-testable without
 *  mutating the module-level CITIES — mirrors resolveSelfHostedConfig's test
 *  seam. NOTE: this seam is on the PRIVATE helper only; resolvePoiFetchMode
 *  itself is NOT changed to accept `cities`. Returns undefined when the city has
 *  no per-city poiFetchMode (→ fall through to the global operator default). */
function perCityOperatorMode(
  cityId: string,
  cities: readonly Pick<CityConfig, "id" | "poiFetchMode">[] = CITIES,
): PoiFetchMode | undefined {
  const city = cities.find((c) => c.id === cityId);
  return city?.poiFetchMode;
}

/** Clamp a resolved POI fetch mode to the operator place-search flow.
 *  The decision governs local-vs-remote ONLY: unless `operator.place-search` is
 *  allowed, the remote "server-side" mode is clamped to the local floor
 *  "eager-bundle". The eager-vs-lazy distinction is privacy-neutral (threat
 *  model: byte-budget is not a privacy win) and is intentionally left untouched. */
export function clampPoiFetchModeToDecision(
  mode: PoiFetchMode,
  placeSearchAllowed: boolean,
): PoiFetchMode {
  if (!placeSearchAllowed && mode === "server-side") return "eager-bundle";
  return mode;
}

/**
 * The raw residency ladder, BEFORE the privacy clamp. 1. per-user override
 * (settingsStore.poiFetchModeOverride) — USER WINS; can opt BACK INTO a local mode even with a
 * configured geocoder, and is also the only rung that selects an explicit "server-side"
 * per-user.
 * 2. per-city operator override (CityConfig.poiFetchMode) — the per-city
 * activation switch; beats the GLOBAL VITE default, loses to 1.
 * 3. global operator default
 * (VITE_PT_POI_FETCH_MODE).
 * 4. "eager-bundle". (Rungs 3 and 4 both resolve in operatorDefault.)
 * A configured self-hosted geocoder NO LONGER forces "server-side": residency- pure server-side
 * is now an EXPLICIT mode choice (per-city/user/VITE). The geocoder is a capability consumed by
 * the address-augmentation gate (searchSuggestions.ts), not by this resolver.
 */
function resolveRawPoiFetchMode(cityId: string): PoiFetchMode {
  const override = useSettingsStore.getState().poiFetchModeOverride;
  if (override !== undefined) return override;                        // 1 — user wins
  const perCity = perCityOperatorMode(cityId);
  if (perCity !== undefined) return perCity;                          // 2 — per-city operator
  return operatorDefault();                                          // 3 / 4
}

/**
 * Resolve the effective POI fetch mode for a city, then clamp it to the operator place-search
 * decision (remote only while `operator.place-search` is allowed). The raw ladder is
 * user-override > per-city operator > global default > "eager-bundle"; the clamp governs
 * local-vs-remote ONLY (eager-vs-lazy is privacy- neutral) and can only move the result toward
 * MORE local, never less.
 */
export function resolvePoiFetchMode(cityId: string): PoiFetchMode {
  return clampPoiFetchModeToDecision(
    resolveRawPoiFetchMode(cityId),
    canUse("operator.place-search"),
  );
}
