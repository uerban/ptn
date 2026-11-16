import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("compact place picker @mock-api", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 54.69, longitude: 25.29 });
    await mockApi(page);
    await page.route("**/poi/manifest.json", route => route.fulfill({ status: 404, body: "" }));
  });
  test("fits four complete suggestions in a keyboard-sized viewport with both place actions", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 360 });
    await page.goto("/search");
    const destination = page.getByRole("searchbox", { name: "Where to?", exact: true });
    await expect(destination).toBeVisible();
    await expect(page.getByRole("button", { name: "Use my current location", exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ptn");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("poiIndex", "readwrite");
      for (let index = 0; index < 6; index++) transaction.objectStore("poiIndex").put({
        id: `vilnius:picker-${index}`, cityId: "vilnius", name: `Space test ${index + 1}`,
        aliases: {}, category: "retail", lat: 54.69, lon: 25.28 + index / 10000,
        geoBucket: "5469_2528", source: "osm", rankBoost: 1, tier: "strict", loadSource: "bundle",
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await destination.fill("Space test");
    await expect(page.getByRole("option")).toHaveCount(6);
    const dimensions = await page.getByRole("option").evaluateAll(elements => ({
      firstTop: elements[0].getBoundingClientRect().top,
      complete: elements.filter(element => element.getBoundingClientRect().bottom <= window.innerHeight).length,
      scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth,
    }));
    expect(dimensions.firstTop).toBeLessThan(130);
    expect(dimensions.complete).toBeGreaterThanOrEqual(4);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    await expect(page.getByRole("button", { name: "Choose on map", exact: true })).toBeVisible();
    await expect(page.locator("nav")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("search-picker-compact.png") });
  });
  test("GPS swap keeps both journey fields and navigation visible", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 660 });
    await page.goto("/search?toName=Airport&toLat=54.6&toLon=25.3");
    await expect(page.getByRole("button", { name: /My location.*Change/ })).toBeVisible();
    await page.getByRole("button", { name: "Swap origin and destination", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "From", exact: true })).toHaveValue("Airport");
    await expect(page.getByRole("searchbox", { name: "Where to?", exact: true })).toHaveValue("My location");
    await expect(page.getByRole("tablist", { name: "Sort", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose on map", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("search-gps-swap.png") });
  });
  test("large text: the header stays short and the sort tabs are not squeezed", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "135%"; });
    });
    await page.goto("/search?toName=Airport&toLat=54.6&toLon=25.3");
    const tabs = page.getByRole("tablist", { name: "Sort", exact: true });
    await expect(tabs).toBeVisible();
    const layout = await tabs.evaluate((list) => {
      const tab = list.querySelector('[role="tab"]')!.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      return { tab: tab.height, top: tab.top - box.top, room: box.bottom - tab.bottom,
        header: box.bottom - list.parentElement!.getBoundingClientRect().top,
        scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth, height: window.innerHeight };
    });
    // The whole tab is inside its row, and the header with the tabs takes less than half the screen.
    expect(layout.tab).toBeGreaterThanOrEqual(24);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.room).toBeGreaterThanOrEqual(0);
    expect(layout.header).toBeLessThan(layout.height / 2);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    const summary = page.getByTestId("when-summary");
    if (await summary.count()) { // Builds without the arrive-by package have no time controls.
      await expect(summary).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("button", { name: "Arrive by", exact: true })).toHaveCount(0);
      await summary.click();
      await expect(page.getByRole("button", { name: "Arrive by", exact: true })).toBeVisible();
      await expect(tabs.getByRole("tab").first()).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath("search-large-text-header.png") });
  });
});
