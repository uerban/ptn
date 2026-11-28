// Special-service notices: the server announces a notices file on the bundle
// response, the app fetches it once and marks the rides it covers. A city
// with no notices header makes no request.
import { test, expect } from "@playwright/test";
import { mockApi, PTB_MATCHED_FIXED_TIME, PTB_MATCHED_STOP_QUERY } from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";

const NOTICES = {
  schemaVersion: 1,
  notices: [{
    id: "vilnius-free-day", city: true, kind: "free", free: true,
    windows: [{ start: "2020-01-01T00:00:00Z", end: "2035-01-01T00:00:00Z" }],
    displayUntil: "2034-12-31", icon: "🎄", source: "https://operator.example/free",
    text: { en: "Free rides on the city's day" },
  }],
};

test.describe("Service notices @mock-api", () => {
  test("route results and nearby departures mark a free ride", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/notices/fetch")) calls.push(r.url()); });
    await mockApi(page, { routingFixture: "ptb-matched", notices: NOTICES });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);

    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
    const badge = page.getByTestId("service-notice-badge").first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText("🎄");
    await expect(badge).toHaveAttribute("title", "Free ride: Free rides on the city's day");
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) expect(new URL(url).search).toBe("");
  });

  test("the home screen lists the special service with its source", async ({ page }) => {
    await mockApi(page, { notices: NOTICES });
    await page.goto("/");
    const list = page.getByTestId("special-services");
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(list).toContainText("Special lines this season");
    await expect(list).toContainText("Free rides on the city's day");
    await expect(list.getByRole("link", { name: /Announcement/ })).toHaveAttribute("href", "https://operator.example/free");
  });

  test("no notices header, no request and no badge", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/notices/fetch")) calls.push(r.url()); });
    await mockApi(page, { routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("service-notice-badge")).toHaveCount(0);
    expect(calls).toEqual([]);
  });
});
