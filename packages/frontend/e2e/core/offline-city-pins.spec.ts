import {expect, test} from "@playwright/test";
import {mockApiAtServiceTime} from "../helpers/mock-api";
import {waitForActiveServiceWorker} from "../helpers/service-worker";

// Both artificial cities serve the same binary fixture and reused stop IDs.
// This checks city ownership and durable pins, independently of geography.
test("two city downloads survive an offline PWA reload and reopen independently @offline", async ({page, context}, testInfo) => {
  test.skip(testInfo.project.name !== "offline", "Requires the built PWA and active service worker");
  test.setTimeout(60_000);
  await mockApiAtServiceTime(page, {routingFixture: "ptb-matched", catalogShapes: "absent"});
  await page.route("**/api/cities", route => route.fulfill({json: {schemaVersion: 2, cities: [
    {id: "vilnius", name: "Vilnius", tz: "Europe/Vilnius", center: {lat: 54.6872, lon: 25.2797},
      bbox: {minLat: 54.6, minLon: 25.1, maxLat: 54.8, maxLon: 25.5}},
    {id: "fixture-city", name: "Fixture City", tz: "Europe/Vilnius", center: {lat: 54.95, lon: 25.28},
      bbox: {minLat: 54.9, minLon: 25.1, maxLat: 55, maxLon: 25.5}},
  ]}}));
  await page.goto("/settings");
  await waitForActiveServiceWorker(page);
  await page.getByRole("button", {name: /^Advanced/}).click();
  const downloads = page.getByRole("region", {name: "Cities on this device"});
  for (const id of ["vilnius", "fixture-city"]) {
    await downloads.getByLabel("City to download").selectOption(id);
    await downloads.getByRole("button", {name: "Open and download", exact: true}).click();
    await expect(downloads.getByRole("status")).toContainText("Timetable saved on this device", {timeout: 20_000});
  }
  await expect(downloads.getByRole("button", {name: "Open Vilnius", exact: true})).toBeEnabled();
  await expect(downloads.getByRole("button", {name: "Open Fixture City", exact: true})).toBeEnabled();

  await context.setOffline(true);
  await page.route("**/api/**", route => route.abort());
  await page.reload({waitUntil: "domcontentloaded"});
  await page.getByRole("button", {name: /^Advanced/}).click();
  for (const [id, name] of [["vilnius", "Vilnius"], ["fixture-city", "Fixture City"]]) {
    await downloads.getByRole("button", {name: `Open ${name}`, exact: true}).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ptn-city")!).state.currentCityId)).toBe(id);
    await expect(downloads.getByRole("button", {name: `Open ${name}`, exact: true})).toBeEnabled();
    await expect(downloads.getByRole("status")).toHaveText("Opened downloaded timetable. Live updates need a connection.");
  }
  await expect(downloads.locator("li")).toHaveCount(2);
  await context.setOffline(false);
});
