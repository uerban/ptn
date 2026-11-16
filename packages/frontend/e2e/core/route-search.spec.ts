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

  test("Settings offers no routing engine choice; planning stays on the device", async ({
    page,
  }) => {
    await page.goto("/settings");

    // The old engine choice lived under Advanced. Picking MOTIS there did not
    // route through MOTIS; it only stopped the timetable loading on the device.
    await page.getByRole("button", { name: /Advanced/ }).click();
    await expect(page.getByRole("heading", { name: "Network services" })).toBeVisible();
    await expect(page.getByText("Routing Engine")).toHaveCount(0);
    await expect(page.locator('input[type="radio"][value="motis"]')).toHaveCount(0);
  });
});
