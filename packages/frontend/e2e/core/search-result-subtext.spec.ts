import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test("native search titles keep readable subtext and select the native label @mock-api", async ({ page }) => {
  await mockApi(page);
  await page.route("**/poi/manifest.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/search");
  const destination = page.getByRole("searchbox").last();
  await expect(destination).toBeVisible();
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ptn");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("poiIndex", "readwrite");
    transaction.objectStore("poiIndex").put({
      id: "vilnius:subtext-fixture", cityId: "vilnius", name: "გალერია თბილისი",
      aliases: { en: ["Galleria Tbilisi"] },
      address: { street: "Rustaveli Avenue", houseNumber: "2/4", locality: "Mtatsminda" },
      category: "retail", lat: 54.69, lon: 25.28, geoBucket: "5469_2528",
      source: "osm", rankBoost: 1, tier: "strict", loadSource: "bundle",
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await destination.fill("Galleria");
  const option = page.getByRole("option", { name: /გალერია თბილისი/ });
  await expect(option).toBeVisible();
  const subtext = option.getByText("Galleria Tbilisi · Rustaveli Avenue 2/4 · Mtatsminda");
  await expect(subtext).toBeVisible();
  const metrics = await subtext.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    overflow: getComputedStyle(element).textOverflow,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.width).toBeGreaterThan(0);
  expect(metrics.overflow).toBe("ellipsis");
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  await page.screenshot({ path: test.info().outputPath("search-subtext.png") });
  await option.click();
  await expect(destination).toHaveValue("გალერია თბილისი");
});
