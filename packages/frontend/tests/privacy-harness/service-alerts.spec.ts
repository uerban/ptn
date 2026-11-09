import { test, expect, type Page, type Request } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../../e2e/helpers/mock-api";
import { setFixedDate } from "../../e2e/helpers/fixed-date";
import { assertNetworkPattern, installNetworkRecorder } from "./assertNetworkPattern";

// Service alerts are one city-wide request. It must not leave before
// Recommended setup or an explicit grant, and it must carry nothing about
// what is on screen: no stop, line, trip or location, in the URL, a body,
// a header or the referrer.

const ALERTS_URL = /\/api\/[^/]+\/alerts(\?|$)/;

/** Answer the alerts endpoint and keep every request to it. */
async function serveAlerts(page: Page): Promise<Request[]> {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (ALERTS_URL.test(request.url())) requests.push(request);
  });
  await page.route(ALERTS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        city: "vilnius",
        fetchedAt: new Date().toISOString(),
        stale: false,
        alerts: [],
      }),
    }),
  );
  return requests;
}

async function finishSetup(page: Page, preset: "recommended" | "strict"): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /^Vilnius/ }).click();
  await page.getByRole("radio", { name: /Text mode/ }).check();
  await page
    .getByRole("button", {
      name: preset === "recommended" ? "Start with recommended settings" : "Start with strict privacy",
    })
    .click();
  await expect(page.getByTestId("setup-shell")).toHaveCount(0);
}

async function openDepartureSheet(page: Page) {
  const row = page.getByTestId("nearby-departure").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const sheet = page.getByTestId("departure-sheet");
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  return sheet;
}

/** Each alerts request names the city and nothing else. */
async function expectCityOnly(requests: readonly Request[]): Promise<void> {
  // Coordinates of the test location and fixture stops, ids of fixture
  // stops and lines: none may appear anywhere in the request.
  const leaks = /54\.\d|25\.\d|lat|lon|stop|route|trip|S\d\b|\br\d\b/i;
  for (const request of requests) {
    const url = new URL(request.url());
    expect(request.method()).toBe("GET");
    expect(url.pathname).toBe("/api/vilnius/alerts");
    expect(url.search).toBe("");
    expect(request.postData()).toBeNull();
    const headers = await request.allHeaders();
    expect(headers.referer, "alerts request sent a referrer").toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    for (const [name, value] of Object.entries(headers)) {
      if (name === "user-agent" || name.startsWith("sec-ch-ua")) continue;
      expect(value, `header ${name}`).not.toMatch(leaks);
    }
  }
}

test.describe("privacy harness — service alerts @mock-api", () => {
  test("Recommended setup turns alerts on; nothing before it", async ({ page }) => {
    await mockApi(page, { setup: "fresh", realtime: "departures, alerts", routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    const alerts = await serveAlerts(page);
    const recorder = installNetworkRecorder(page);

    await page.goto("/");
    await page.getByRole("button", { name: /^Vilnius/ }).click();
    await page.getByRole("radio", { name: /Text mode/ }).check();
    await expect(page.getByRole("button", { name: "Start with recommended settings" })).toBeVisible();
    assertNetworkPattern(recorder, [{ kind: "service-alerts", maxCount: 0 }]);

    await page.getByRole("button", { name: "Start with recommended settings" }).click();
    await expect(page.getByTestId("setup-shell")).toHaveCount(0);
    await openDepartureSheet(page);
    await expect.poll(() => alerts.length, { timeout: 10_000 }).toBeGreaterThan(0);

    // A page whose address names stops and coordinates.
    const before = alerts.length;
    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => alerts.length, { timeout: 10_000 }).toBeGreaterThan(before);

    await expectCityOnly(alerts);
    recorder.stop();
  });

  test("Strict setup asks nothing until alerts are turned on", async ({ page }) => {
    await mockApi(page, { setup: "fresh", realtime: "departures, alerts" });
    const alerts = await serveAlerts(page);
    const recorder = installNetworkRecorder(page);

    await finishSetup(page, "strict");
    const sheet = await openDepartureSheet(page);
    const offer = sheet.getByTestId("service-alerts-offer");
    await expect(offer).toBeVisible();
    // Give a wrongly started poll time to show up.
    await page.waitForTimeout(1_000);
    assertNetworkPattern(recorder, [{ kind: "service-alerts", maxCount: 0 }]);

    await offer.getByRole("button", { name: "Turn on" }).click();
    await expect.poll(() => alerts.length, { timeout: 10_000 }).toBeGreaterThan(0);
    assertNetworkPattern(recorder, [{ kind: "service-alerts", minCount: 1 }]);

    await expectCityOnly(alerts);
    recorder.stop();
  });
});
