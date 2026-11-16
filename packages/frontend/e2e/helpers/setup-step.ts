import type { Page } from "@playwright/test";

/** Heading of the second setup step (after the city is chosen). */
export const SETUP_HEADING = "Ready to start";

/** The one big action of the second step while Map mode is selected. */
export const START_MAP_ACTION = "Continue to the map";

/**
 * Open "More options and details" on the second setup step. The start-mode
 * choice, Strict privacy and Customize live behind it. Safe to call when it
 * is already open; the disclosure closes again on reload.
 */
export async function openSetupOptions(page: Page): Promise<void> {
  const summary = page.getByText("More options and details", { exact: true });
  await summary.waitFor();
  const open = await summary.evaluate(
    (el) => (el.closest("details") as HTMLDetailsElement | null)?.open ?? false,
  );
  if (!open) await summary.click();
}

/**
 * Accessible name of the button that finishes setup. Recommended reads
 * "Continue to the map" while Map mode is selected.
 */
export function setupActionName(
  preset: "recommended" | "strict",
  mode: "Text" | "Map",
): string {
  if (preset === "strict") return "Start with strict privacy";
  return mode === "Map" ? START_MAP_ACTION : "Start with recommended settings";
}
