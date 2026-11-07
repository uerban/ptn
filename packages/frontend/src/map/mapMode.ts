/**
 * The single map-mode choice.
 *
 * Two controls used to answer almost the same question: the Settings "Map
 * detail" radio (`settingsStore.mapDetailMode`) and the privacy centre's
 * "Detailed map" axis (`policy.basemapMode`). A user could set them to
 * disagree, and the map then obeyed whichever was stricter — the classic
 * "why is my setting ignored?" trap. There is now ONE control (Settings →
 * Map) and this module is the seam between it and the policy axis:
 *
 *   - `basemapModeFor` maps a chosen mode onto the axis value it implies,
 *   - `applyMapMode` writes both at once (axis via override, exactly the way
 *     `PolicyAxisControl` does: clear when it equals the level floor, set
 *     otherwise, so lowering the privacy level un-sticks it),
 *   - `effectiveMapMode` resolves what the canvas should actually draw, given
 *     that the privacy level can still clamp the external basemap away.
 *
 * The policy axis remains the ceiling — a preset that floors `basemapMode` to
 * `local-only` makes the "detailed" option unselectable rather than silently
 * overriding it (`isDetailedMapLocked`).
 */
import {
  compatLevelFloor,
  PRIVACY_LEVELS,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared/privacy";
import {
  useSettingsStore,
  type MapDetailMode,
} from "../stores/settingsStore.ts";
import { usePolicy } from "../stores/privacyStore.ts";

/** Presentation order of the single map-mode control (loosest first). */
export const MAP_MODE_ORDER = [
  "detailed",
  "micromap",
  "gtfs-only",
] as const satisfies readonly MapDetailMode[];

export function basemapModeFor(
  mode: MapDetailMode,
): PrivacyPolicy["basemapMode"] {
  return mode === "detailed" ? "external-detailed" : "local-only";
}

/** True when the level preset floors the axis at `local-only`, i.e. the
 *  external basemap cannot be selected without lowering the privacy level. */
export function isDetailedMapLocked(level: PrivacyLevel): boolean {
  return compatLevelFloor(level).basemapMode === "local-only";
}

/**
 * The lowest privacy level at which the external basemap is still selectable.
 * Mirrors `PolicyAxisControl.minLevelForOption` for the one axis this control
 * owns, so the locked copy names the same level in both places.
 */
export function maxLevelForDetailedMap(): PrivacyLevel {
  let best = PRIVACY_LEVELS[0];
  for (const level of PRIVACY_LEVELS) {
    if (compatLevelFloor(level).basemapMode === "external-detailed") best = level;
  }
  return best;
}

/**
 * What the canvas draws. A `detailed` preference is demoted to `micromap`
 * whenever policy withholds the external basemap: dots on an empty background
 * are strictly worse than the local city outline we already ship.
 */
export function effectiveMapMode(
  mode: MapDetailMode,
  basemapMode: PrivacyPolicy["basemapMode"],
): MapDetailMode {
  if (mode === "detailed" && basemapMode !== "external-detailed") {
    return "micromap";
  }
  return mode;
}

interface ApplyMapModeDeps {
  level: PrivacyLevel;
  setMapDetailMode: (mode: MapDetailMode) => void;
  setOverride: <K extends keyof PrivacyPolicy>(
    axis: K,
    value: PrivacyPolicy[K],
  ) => void;
  clearOverride: <K extends keyof PrivacyPolicy>(axis: K) => void;
}

/** Apply the single choice to both the display setting and the policy axis. */
export function applyMapMode(
  mode: MapDetailMode,
  { level, setMapDetailMode, setOverride, clearOverride }: ApplyMapModeDeps,
): void {
  setMapDetailMode(mode);
  const desired = basemapModeFor(mode);
  if (desired === compatLevelFloor(level).basemapMode) {
    clearOverride("basemapMode");
  } else {
    setOverride("basemapMode", desired);
  }
}

/** React binding for `effectiveMapMode` — the one hook map layers should use. */
export function useEffectiveMapMode(): MapDetailMode {
  const mode = useSettingsStore((s) => s.mapDetailMode);
  const basemapMode = usePolicy().basemapMode;
  return effectiveMapMode(mode, basemapMode);
}
