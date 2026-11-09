/**
 * The single map-mode choice.
 *
 * The Settings map control (`settingsStore.mapDetailMode`) is a display
 * preference. Whether the detailed map may reach its external provider is a
 * separate, per-provider network decision (`external.detailed-basemap`). This
 * module is the seam between the two:
 *
 *   - `applyMapMode` stores the preference and, when the user deliberately
 *     picks the detailed map, records the decision for its provider. Picking
 *     a local mode never rewrites the decision.
 *   - `effectiveMapMode` resolves what the canvas actually draws: a detailed
 *     preference without an allowed provider falls back to the micromap.
 *
 * The detailed option is only unselectable when its provider cannot run at all
 * (`isDetailedMapLocked`), never because of the protection level.
 */
import {
  useSettingsStore,
  type MapDetailMode,
} from "../stores/settingsStore.ts";
import {
  DEFAULT_BASEMAP_PROVIDER,
  DETAILED_BASEMAP_FLOW,
  useExternalBasemapAllowed,
} from "../services/basemapPrivacy.ts";
import { grantFlow, isFlowAvailable } from "../privacy/flowGrants.ts";

/** Presentation order of the single map-mode control (loosest first). */
export const MAP_MODE_ORDER = [
  "detailed",
  "micromap",
  "gtfs-only",
] as const satisfies readonly MapDetailMode[];

/** True when the detailed map's provider cannot run in this build. */
export function isDetailedMapLocked(
  providerId: string = DEFAULT_BASEMAP_PROVIDER,
): boolean {
  return !isFlowAvailable(DETAILED_BASEMAP_FLOW, providerId);
}

/**
 * What the canvas draws. A `detailed` preference is demoted to `micromap`
 * whenever the provider is not allowed: dots on an empty background are
 * strictly worse than the local city outline we already ship.
 */
export function effectiveMapMode(
  mode: MapDetailMode,
  basemapAllowed: boolean,
): MapDetailMode {
  if (mode === "detailed" && !basemapAllowed) {
    return "micromap";
  }
  return mode;
}

interface ApplyMapModeDeps {
  setMapDetailMode: (mode: MapDetailMode) => void;
  /** Records the decision; defaults to a Settings grant. */
  grantDetailedMap?: (providerId: string) => void;
  providerId?: string;
}

function grantDetailedMapInSettings(providerId: string): void {
  grantFlow(DETAILED_BASEMAP_FLOW, "settings", providerId);
}

/** Apply the single choice: the display preference, plus the provider grant
 * when the detailed map is chosen. */
export function applyMapMode(
  mode: MapDetailMode,
  {
    setMapDetailMode,
    grantDetailedMap = grantDetailedMapInSettings,
    providerId = DEFAULT_BASEMAP_PROVIDER,
  }: ApplyMapModeDeps,
): void {
  if (mode === "detailed") grantDetailedMap(providerId);
  setMapDetailMode(mode);
}

/** React binding for `effectiveMapMode` — the one hook map layers should use. */
export function useEffectiveMapMode(): MapDetailMode {
  const mode = useSettingsStore((s) => s.mapDetailMode);
  const basemapAllowed = useExternalBasemapAllowed();
  return effectiveMapMode(mode, basemapAllowed);
}
