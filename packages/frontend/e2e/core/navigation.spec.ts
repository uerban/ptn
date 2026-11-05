import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("search bar navigates to /search", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Where are you going?" }).click();
    await expect(page).toHaveURL(/\/search/);
  });

  test("Settings tab navigates to /settings", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test("Map tab navigates back to /", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("link", { name: "Map" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("Search tab navigates to /search", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Search" }).click();
    await expect(page).toHaveURL(/\/search/);
  });

  test("browser back navigation works", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });
});
