/**
 * Actions the setup shell takes. Choosing a city selects it and refreshes its
 * transit-data manifest (a necessary request that also tells setup whether
 * the city publishes live departures and service alerts). Choosing a preset
 * commits the setup journal; nothing optional starts before that.
 */
import type { GuidedNetworkChoice, OnboardingPresetId } from "@pt/shared/privacy";
import type { CityConfig } from "../config/cities.ts";
import type { PresentationChoice, StartMode } from "../services/onboardingRecord.ts";
import { LATEST_WHATS_NEW_ID } from "../services/whatsNew.ts";

/** How long city selection waits for the manifest before moving on. */
export const MANIFEST_WAIT_MS = 3000;

export async function chooseSetupCity(
  city: CityConfig,
  options: { offline: boolean; waitMs?: number },
): Promise<void> {
  const { useCityStore } = await import("../stores/cityStore.ts");
  useCityStore.getState().setActiveCity(city);
  if (options.offline) return;
  const { warmManifest } = await import("../services/scheduleTileReadPath.ts");
  await Promise.race([
    warmManifest(),
    new Promise<void>((resolve) => setTimeout(resolve, options.waitMs ?? MANIFEST_WAIT_MS)),
  ]);
}

/** Presentation written by setup. Both modes use the minimal offline map:
 * detailed maps are a separate, provider-specific choice. */
export function setupPresentation(startMode: StartMode): PresentationChoice {
  return { startMode, mapDetail: "micromap", nearbyCards: true };
}

export interface CompleteSetupInput {
  readonly presetId: OnboardingPresetId;
  readonly guidedChoice?: GuidedNetworkChoice;
  readonly startMode: StartMode;
}

/** Commit setup. Returns whether the choices were stored for later launches. */
export async function completeSetup(input: CompleteSetupInput): Promise<{ stored: boolean }> {
  const { useOnboardingStore } = await import("../stores/onboardingStore.ts");
  await useOnboardingStore.getState().commitSetup({
    presetId: input.presetId,
    ...(input.guidedChoice ? { guidedChoice: input.guidedChoice } : {}),
    presentation: setupPresentation(input.startMode),
    // A new installation has nothing to catch up on.
    seenWhatsNew: LATEST_WHATS_NEW_ID,
  });
  if (input.startMode === "map") {
    void import("./mapAssets.ts").then(({ warmMapAssets }) => warmMapAssets());
  }
  return { stored: useOnboardingStore.getState().storageAvailable };
}
