import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Rehydrate round-trip tests for the bicycle mobilityProfile.
 *
 * These tests cover the three settings-store sites that must be updated
 * together with the MobilityProfile union widen:
 *   1. PROFILE_DEFAULT_BUFFER_SECS (Record<MobilityProfile, number>) — exhaustiveness
 *   2. VALID_MOBILITY_PROFILES — allowlist used in the persist merge guard
 *   3. The bootstrap guard in the top-level if(window) block
 *
 * The merge guard is exercised by seeding localStorage with a persisted
 * state containing `mobilityProfile:"bicycle"` before re-importing the
 * module (vi.resetModules() ensures a fresh module each time).
 */

describe("settingsStore — bicycle mobilityProfile rehydrate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("persisted bicycle mobilityProfile survives a rehydrate round-trip via the merge guard", async () => {
    // Seed localStorage with a persisted state that has mobilityProfile: "bicycle".
    // Zustand persist wraps the payload as { state: { ... } }.
    localStorage.setItem(
      "ptn-settings",
      JSON.stringify({ state: { mobilityProfile: "bicycle" } }),
    );

    const mod = await import("../../src/stores/settingsStore.ts");
    // After the merge, the store must reflect the persisted value.
    // If "bicycle" is missing from VALID_MOBILITY_PROFILES, it silently
    // falls back to the current default ("default"), and this assertion fails.
    expect(mod.useSettingsStore.getState().mobilityProfile).toBe("bicycle");
  });

  it("rejects unknown profile values and falls back to the store default", async () => {
    localStorage.setItem(
      "ptn-settings",
      JSON.stringify({ state: { mobilityProfile: "hoverboard" } }),
    );

    const mod = await import("../../src/stores/settingsStore.ts");
    // "hoverboard" is not a valid MobilityProfile — must fall back to default.
    expect(mod.useSettingsStore.getState().mobilityProfile).toBe("default");
  });

  it("setMobilityProfile accepts bicycle without throwing", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    // This would throw or produce a type error if "bicycle" is not in the union.
    mod.useSettingsStore.getState().setMobilityProfile("bicycle");
    expect(mod.useSettingsStore.getState().mobilityProfile).toBe("bicycle");
  });
});
