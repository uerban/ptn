import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Route search @mock-api", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 54.35, longitude: 18.65 });
    await mockApi(page);
  });

  test("RAPTOR adapter does not call /plan API endpoint", async ({ page }) => {
    await page.addInitScript(() => {
      const settings = {
        state: { preferredAdapter: "raptor" },
        version: 0,
      };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });

    const planCalls: string[] = [];
    await page.route("**/api/plan*", (route) => {
      planCalls.push(route.request().url());
      route.fulfill({ json: { data: { itineraries: [] } } });
    });

    await page.goto("/search?toLat=54.36&toLon=18.66&toName=Test%20Stop");

    // Wait for any routing logic to fire. Even if geolocation sets
    // fromLocation, the RAPTOR path should not call /plan.
    await page.waitForTimeout(5000);

    expect(planCalls).toHaveLength(0);
  });

  test("Settings page shows RAPTOR as an available routing engine", async ({
    page,
  }) => {
    await page.goto("/settings");

    // Expand the Advanced section
    await page.getByRole("button", { name: /Advanced/ }).click();

    // RAPTOR option should be visible and selectable
    const raptorLabel = page.locator("text=RAPTOR (on-device)");
    await expect(raptorLabel).toBeVisible({ timeout: 5000 });

    // MOTIS option should also be visible
    const motisLabel = page.locator("text=MOTIS (Transitous)");
    await expect(motisLabel).toBeVisible({ timeout: 5000 });
  });

  test("RAPTOR is selected as default routing engine", async ({ page }) => {
    await page.goto("/settings");

    // Expand the Advanced section
    await page.getByRole("button", { name: /Advanced/ }).click();

    // The RAPTOR radio button should be checked by default
    const raptorRadio = page.locator('input[type="radio"][value="raptor"]');
    await expect(raptorRadio).toBeChecked({ timeout: 5000 });
  });
});
