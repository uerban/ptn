import {test, expect} from "@playwright/test";
import {mockApi} from "../helpers/mock-api";
import {mockWalkGraph} from "../helpers/walk-graph-fixture";
import {waitForActiveServiceWorker} from "../helpers/service-worker";
import {REF_FIXED_TIME} from "./route-overlay-refUrl";

test("walking search and first text guidance survive a cached PWA reload @offline", async ({page, context}, testInfo) => {
  test.skip(testInfo.project.name !== "offline", "Requires built PWA with service workers enabled");
  test.setTimeout(60_000);
  await context.setGeolocation({latitude: 54.68, longitude: 25.28});
  await page.clock.setFixedTime(REF_FIXED_TIME);
  await mockApi(page, {catalogNow: REF_FIXED_TIME});
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem("ptn-settings") ?? "{}");
    settings.state = {...settings.state, scheduleMode: true};
    localStorage.setItem("ptn-settings", JSON.stringify(settings));
  });
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
  await card.click();
  await expect(page.getByTestId("leg-row")).toHaveCount(1);
  await expect(page.getByTestId("text-guidance")).toBeVisible();
  expect(plans).toEqual([]);
});
