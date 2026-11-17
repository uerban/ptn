import type { OnboardingPresetId } from "@pt/shared/privacy";
import type { StartMode } from "../services/onboardingRecord.ts";

/** The detailed-map flow and the provider setup offers. Literal here so setup
 * does not load the map's privacy module; a test keeps them in step. */
export const SETUP_DETAILED_MAP = {
  flowId: "external.detailed-basemap",
  providerId: "carto",
} as const;

/** Setup shows the map choice only in Map mode and not under Strict. */
export function setupAsksMap(presetId: OnboardingPresetId, startMode: StartMode): boolean {
  return startMode === "map" && presetId !== "strict";
}
