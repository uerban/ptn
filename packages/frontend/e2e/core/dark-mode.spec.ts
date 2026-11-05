import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Dark mode", () => {
  test("toggling dark theme adds dark attribute to html", async ({ page }) => {
    await mockApi(page);
    await page.goto("/settings");

    await page.getByLabel("dark").click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("toggling light theme sets light attribute", async ({ page }) => {
    await mockApi(page);
    await page.goto("/settings");

    await page.getByLabel("dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByLabel("light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
