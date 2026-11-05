import type { Page } from "@playwright/test";
import type { PrivacyLevel, PrivacyPolicy } from "@pt/shared";

// Pre-seeds privacyStore persisted state via Playwright's `addInitScript`
// so the app reads the requested level + overrides on its very first render
// — no race against the hydration tick.
//
// Also seeds `ptn-city` so Home's "auto-detect nearest city on first visit"
// branch is skipped. Without this seed, geolocation (configured in
// `playwright.config.ts`) races against the boot-idle window: if it
// resolves before the 5s timer, the active city flips and the per-city
// effects (health probe, stops/all, color-config) re-fire for the new
// cityId — so the same scenario captures either one or two cycles
// depending on geolocation timing. Pinning the city makes the scenario
// deterministic.
//
// Mirrors the on-disk shape produced by zustand `persist`:
//   localStorage["ptn-privacy"] = {"state":{level,overrides},"version":0}
//   localStorage["ptn-settings"] = {"state":{...display overrides},"version":0}
//
// MUST be called BEFORE `page.goto(...)`. Calling after navigation has no
// effect because the stores have already hydrated.
export async function bootAtPrivacyLevel(
  page: Page,
  level: PrivacyLevel,
  overrides: Partial<PrivacyPolicy> = {},
): Promise<void> {
  const payload = {
    state: { level, overrides },
    version: 0,
  };
  // Pin the active city so geolocation-driven re-detection does not fire
  // during the boot-idle window (see note above).
  const cityPayload = {
    state: {
      activeCity: {
        id: "vilnius",
        name: "Vilnius",
        center: { lat: 54.6872, lon: 25.2797 },
        bbox: {
          minLat: 54.62,
          minLon: 25.15,
          maxLat: 54.75,
          maxLon: 25.42,
        },
        available: true,
      },
    },
    version: 0,
  };
  const settingsPayload = {
    state: {
      scheduleMode: false,
      mapDetailMode: "detailed",
    },
    version: 0,
  };
  await page.addInitScript(
    ({ payload, cityPayload, settingsPayload }) => {
      localStorage.setItem("ptn-privacy", JSON.stringify(payload));
      localStorage.setItem("ptn-city", JSON.stringify(cityPayload));
      localStorage.setItem("ptn-settings", JSON.stringify(settingsPayload));
    },
    { payload, cityPayload, settingsPayload },
  );
}
