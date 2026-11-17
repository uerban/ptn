/**
 * Actions the setup shell takes. Choosing a city selects it and refreshes its
 * transit-data manifest (a necessary request that also tells setup whether
 * the city publishes live departures and service alerts). Choosing a preset
 * commits the setup journal; nothing optional starts before that.
 */
import {
  decisionKey,
  type GuidedNetworkChoice,
  type OnboardingPresetId,
} from "@pt/shared/privacy";
import type { CityConfig } from "../config/cities.ts";
import type { PresentationChoice, StartMode } from "../services/onboardingRecord.ts";
import { LATEST_WHATS_NEW_ID } from "../services/whatsNew.ts";
import { markMapDetailAsked } from "../map/mapDetailAsked.ts";
import { SETUP_DETAILED_MAP, setupAsksMap } from "./setupMapChoice.ts";

export { SETUP_DETAILED_MAP, setupAsksMap };


/** How long city selection waits for the manifest before moving on. */
export const MANIFEST_WAIT_MS = 3000;

export async function chooseSetupCity(
  city: CityConfig,
  options: { offline: boolean; waitMs?: number },
): Promise<void> {
  await activateSetupCity(city);
  if (options.offline) return;
  const { warmManifest } = await import("../services/scheduleTileReadPath.ts");
  await Promise.race([
    warmManifest(),
    new Promise<void>((resolve) => setTimeout(resolve, options.waitMs ?? MANIFEST_WAIT_MS)),
  ]);
}

/** Make `city` the selected city without any request. Setup uses this when it
 * starts with a city it did not ask about (the only one offered). */
export async function activateSetupCity(city: CityConfig): Promise<void> {
  const { useCityStore } = await import("../stores/cityStore.ts");
  // Always written, so the choice is stored even when it is the default.
  useCityStore.getState().setActiveCity(city);
}

/** Presentation written by setup: the minimal offline map unless detailed
 * maps were chosen on the setup page. */
export function setupPresentation(startMode: StartMode, detailedMap = false): PresentationChoice {
  return { startMode, mapDetail: detailedMap ? "detailed" : "micromap", nearbyCards: true };
}


export interface CompleteSetupInput {
  readonly presetId: OnboardingPresetId;
  readonly guidedChoice?: GuidedNetworkChoice;
  readonly startMode: StartMode;
  /** Answer to the setup page's map choice, when it was shown. */
  readonly detailedMap?: boolean;
}

/** Commit setup. Returns whether the choices were stored for later launches. */
export async function completeSetup(input: CompleteSetupInput): Promise<{ stored: boolean }> {
  const { useOnboardingStore } = await import("../stores/onboardingStore.ts");
  const asked = setupAsksMap(input.presetId, input.startMode);
  const detailedKey = decisionKey(SETUP_DETAILED_MAP.flowId, SETUP_DETAILED_MAP.providerId);
  const detailed = asked && input.detailedMap === true && detailedKey !== undefined;
  await useOnboardingStore.getState().commitSetup({
    presetId: input.presetId,
    ...(input.guidedChoice ? { guidedChoice: input.guidedChoice } : {}),
    ...(detailed && detailedKey ? { extraFlows: { [detailedKey]: "allowed" as const } } : {}),
    presentation: setupPresentation(input.startMode, detailed),
    // A new installation has nothing to catch up on.
    seenWhatsNew: LATEST_WHATS_NEW_ID,
  });
  // Answered here, so the map does not ask again. Text mode and Strict never
  // saw the choice and keep the one-time question on the map.
  if (asked) markMapDetailAsked();
  if (input.startMode === "map") {
    void import("./mapAssets.ts").then(({ warmMapAssets }) => warmMapAssets());
  }
  return { stored: useOnboardingStore.getState().storageAvailable };
}
