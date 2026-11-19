import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

// The map's attribution link ("Map data © OpenStreetMap…") also matches a
// loose "Map" name, so look only at the bottom navigation, by exact name.
function nav(page: Page, name: string) {
  return page.getByRole("navigation").getByRole("link", { name, exact: true });
}

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("Settings tab navigates to /settings", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Settings").click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test("Map tab navigates back to /", async ({ page }) => {
    await page.goto("/settings");
    await nav(page, "Map").click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("Search tab navigates to /search", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Search").click();
    await expect(page).toHaveURL(/\/search/);
  });

  test("browser back navigation works", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Settings").click();
    await expect(page).toHaveURL(/\/settings/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });
});
