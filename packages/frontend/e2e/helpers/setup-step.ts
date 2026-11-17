import type { Page } from "@playwright/test";

/** Heading of the second setup step (after the city is chosen). */
export const SETUP_HEADING = "Ready to start";

/** The Continue action while the preselected Recommended level is chosen. */
export const START_MAP_ACTION = "Continue with Recommended";

/**
 * The second setup step shows every choice on the page now; kept so specs
 * can wait for the step before picking a choice.
 */
export async function openSetupOptions(page: Page): Promise<void> {
  await page.getByRole("group", { name: "Privacy level" }).waitFor();
}

/** Pick a privacy level on the second setup step. */
export async function chooseSetupLevel(
  page: Page,
  preset: "recommended" | "strict" | "customize",
): Promise<void> {
  const name = { recommended: /^Recommended/, strict: /^Strict/, customize: /^Custom/ }[preset];
  await page.getByRole("group", { name: "Privacy level" }).getByRole("radio", { name }).check();
}

/** Pick a level and press Continue, which names that level. */
export async function startWithLevel(page: Page, preset: "recommended" | "strict"): Promise<void> {
  await chooseSetupLevel(page, preset);
  await page.getByRole("button", { name: setupActionName(preset) }).click();
}

/** Accessible name of the button that finishes setup for a level. */
export function setupActionName(preset: "recommended" | "strict", _mode?: "Text" | "Map"): string {
  return preset === "strict" ? "Continue with Strict" : "Continue with Recommended";
}
