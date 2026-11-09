import { test, expect, type Page } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../../e2e/helpers/mock-api";
import { setFixedDate } from "../../e2e/helpers/fixed-date";
import { seedNetworkDecisions } from "../../e2e/helpers/setup-complete";
import { pathBearingReferrers, recordRequests } from "../../e2e/helpers/request-allowlist";

// Page addresses name stops, lines, trips and coordinates. No request, to the
// operator or to any provider, may carry that address as its referrer: the
// app sends at most its origin.

/** Answer every request that leaves the app origin with an empty body. */
async function stubOtherOrigins(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    (route) => {
      const url = route.request().url();
      if (/style\.json|\.json(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ version: 8, sources: {}, layers: [] }),
        });
      }
      return route.fulfill({ status: 204, body: "" });
    },
  );
}

test.describe("privacy harness — referrer @mock-api", () => {
  test("no request names the page it came from", async ({ page }) => {
    await mockApi(page, { realtime: "departures, alerts", routingFixture: "ptb-matched" });
    await seedNetworkDecisions(page, { "external.detailed-basemap@carto": "allowed" });
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
      settings.state = { ...settings.state, mapDetailMode: "detailed" };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await stubOtherOrigins(page);
    const requests = recordRequests(page);

    // Enter on an address that names two stops, then use the map.
    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("itinerary-card").first().click();
    await page.waitForTimeout(2_000);
    await page.goto("/?lat=54.6872&lon=25.2797");
    await page.waitForTimeout(3_000);

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some(({ referer }) => referer !== undefined)).toBe(true);
    expect(pathBearingReferrers(requests)).toEqual([]);
  });
});
