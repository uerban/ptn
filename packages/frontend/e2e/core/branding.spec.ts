import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Branding", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
  });

  test("page title is PTN/HU·LO", async ({ page }) => {
    await expect(page).toHaveTitle("PTN/HU·LO");
  });

  test("theme-color meta tag is #2460A7", async ({ page }) => {
    const content = await page
      .locator('meta[name="theme-color"]')
      .getAttribute("content");
    expect(content).toBe("#2460A7");
  });

  test("favicon.svg is accessible", async ({ page }) => {
    const response = await page.request.get("/favicon.svg");
    expect(response.ok()).toBe(true);
  });

  test("iOS home-screen icon is a PNG at the linked and probed paths", async ({ page }) => {
    // Safari falls back to a letter tile when the touch icon is missing or is
    // served the SPA's HTML fallback, so every path it may use must be a PNG.
    const linked = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    for (const path of [linked!, "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
      const response = await page.request.get(path);
      expect(response.ok(), path).toBe(true);
      expect(response.headers()["content-type"], path).toContain("image/png");
    }
  });

  test("favicon.ico is an icon, not the SPA fallback", async ({ page }) => {
    const response = await page.request.get("/favicon.ico");
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).not.toContain("text/html");
  });

  test("Open Graph meta tags are present", async ({ page }) => {
    const ogTitle = await page
      .locator('meta[property="og:title"]')
      .getAttribute("content");
    expect(ogTitle).toContain("PTN/HU·LO");

    const ogType = await page
      .locator('meta[property="og:type"]')
      .getAttribute("content");
    expect(ogType).toBe("website");
  });

  test("PWA manifest has correct name and icons", async ({ page }) => {
    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    expect(manifestHref).toBeTruthy();

    const response = await page.request.get(manifestHref!);
    const manifest = await response.json();
    expect(manifest.name).toBe("PTN/HU·LO — Public Transport Navigator");
    expect(manifest.short_name).toBe("PTN/HU·LO");
    expect(manifest.theme_color).toBe("#2460A7");
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((i: any) => i.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((i: any) => i.sizes === "512x512")).toBe(true);
    expect(manifest.icons.some((i: any) => i.purpose === "maskable")).toBe(true);
  });
});
