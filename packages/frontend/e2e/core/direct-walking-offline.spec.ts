import {test, expect} from "@playwright/test";
import {mockApi} from "../helpers/mock-api";
import {mockWalkGraph} from "../helpers/walk-graph-fixture";
import {waitForActiveServiceWorker} from "../helpers/service-worker";
import {REF_FIXED_TIME} from "./route-overlay-refUrl";

for (const textMode of [true, false]) {
test(`walking search and first guidance survive a cached PWA reload (${textMode ? "text" : "map"}) @offline`, async ({page, context}, testInfo) => {
  test.skip(testInfo.project.name !== "offline", "Requires built PWA with service workers enabled");
  test.setTimeout(60_000);
  await context.setGeolocation({latitude: 54.68, longitude: 25.28});
  await page.clock.setFixedTime(REF_FIXED_TIME);
  await mockApi(page, {catalogNow: REF_FIXED_TIME});
  await page.addInitScript((textMode) => {
    const settings = JSON.parse(localStorage.getItem("ptn-settings") ?? "{}");
    settings.state = {...settings.state, scheduleMode: textMode};
    localStorage.setItem("ptn-settings", JSON.stringify(settings));
  }, textMode);
  await mockWalkGraph(page);
  await page.goto("/search?toLat=54.68&toLon=25.281&toName=Pedestrian%20fixture");
  const card = page.getByTestId("itinerary-card").first();
  await expect(card).toContainText(/64/, {timeout: 20_000});
  await waitForActiveServiceWorker(page);
  // Guidance has never been opened. Reload discards all in-memory routes and
  // graph workers; only retained graph/GTFS bytes and the PWA cache can help.
  await context.setOffline(true);
  // Page routes take precedence over context routes; block both so neither
  // API page fixtures nor worker graph fixtures can fake an offline success.
  await page.route("**/*", route => route.abort("internetdisconnected"));
  await context.route("**/*", route => route.abort("internetdisconnected"));
  const plans: string[] = [];
  page.on("request", request => {
    if (/\/api\/(?:[^/]+\/)?plan(?:\/|$)/.test(new URL(request.url()).pathname)) plans.push(request.url());
  });
  await page.reload({waitUntil: "domcontentloaded"});
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(card).toContainText(/64/, {timeout: 20_000});
  const failedRequests: string[] = [];
  page.on("requestfailed", request => failedRequests.push(request.url()));
  await card.click();
  await expect(page.getByTestId("leg-row")).toHaveCount(1);
  await expect(page.getByTestId("text-guidance")).toBeVisible();
  if (!textMode) {
    await expect(page.getByRole("status").filter({hasText: "map could not be loaded"})).toBeVisible();
    expect(failedRequests.some(url => /\/assets\/(?:maplibre|vendor-map)-/.test(url))).toBe(true);
    // Recovery is temporary; it does not change the rider's saved map view.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ptn-settings")!).state.scheduleMode)).toBe(false);
  }
  await testInfo.attach("offline-failed-requests", {body: JSON.stringify(failedRequests), contentType: "application/json"});
  expect(plans).toEqual([]);
});

}
