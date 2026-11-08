// Every request a profile makes must be on the documented allowlist
// (`helpers/request-allowlist.ts`) for the choices it made: before any choice,
// after Recommended or Strict setup in Text and Map mode, and after a single
// service is turned on and off again. Optional endpoints on the app's own
// origin (alerts, live times, nearby lookup, place search, remote routing)
// count as optional too, not just other domains. No request may carry a
// referrer naming the page it came from.
import { test, expect, type Page } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";
import { waitForActiveServiceWorker } from "../helpers/service-worker";
import {
  disallowedRequests,
  pathBearingReferrers,
  recordRequests,
  type RecordedRequest,
  type RequestGroup,
} from "../helpers/request-allowlist";

// Setup must never be what asks for location.
test.use({ permissions: [] });

const NECESSARY: readonly RequestGroup[] = ["shell", "transit-data"];
const LIVE: readonly RequestGroup[] = ["operator.realtime", "operator.service-alerts"];

type Preset = "recommended" | "strict";
type StartMode = "Text" | "Map";

async function serveAlerts(page: Page): Promise<void> {
  await page.route(/\/api\/[^/]+\/alerts(\?|$)/, (route) =>
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
}

async function freshProfile(page: Page): Promise<RecordedRequest[]> {
  await mockApi(page, {
    setup: "fresh",
    realtime: "departures, alerts",
    routingFixture: "ptb-matched",
  });
  await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
  await serveAlerts(page);
  return recordRequests(page);
}

async function chooseCity(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /^Vilnius/ }).click();
  await expect(page.getByRole("heading", { name: "How would you like to plan and explore?" })).toBeVisible();
}

async function finishSetup(page: Page, preset: Preset, mode: StartMode): Promise<void> {
  await chooseCity(page);
  await page.getByRole("radio", { name: new RegExp(`${mode} mode`) }).check();
  await page
    .getByRole("button", {
      name: preset === "recommended" ? "Start with recommended settings" : "Start with strict privacy",
    })
    .click();
  await expect(page.getByTestId("setup-shell")).toHaveCount(0);
  // Nearby departures need a position; granting it after setup keeps setup
  // itself free of any location request.
  await page.context().grantPermissions(["geolocation"]);
}

/** Open the nearest stop's departures from the Text mode lists. */
async function openNearbyStop(page: Page): Promise<void> {
  const stop = page.getByRole("region", { name: "Nearby stops" }).getByRole("listitem").getByRole("button").first();
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  await expect(page.getByTestId("departure-sheet")).toBeVisible({ timeout: 10_000 });
}

/** Use the app the way the scenarios compare: home, then planned routes. */
async function useApp(page: Page, mode: StartMode): Promise<void> {
  if (mode === "Text") {
    await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 15_000 });
    await openNearbyStop(page);
  } else {
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
  }
  // A page whose address names stops: its requests must not repeat it.
  await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
  await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
  // Give pollers and lazy loads time to show up.
  await page.waitForTimeout(1_500);
}

function expectAllowed(
  page: Page,
  requests: readonly RecordedRequest[],
  active: readonly RequestGroup[],
): void {
  const origin = new URL(page.url()).origin;
  expect(disallowedRequests(requests, origin, active), "requests outside the allowlist").toEqual([]);
  expect(pathBearingReferrers(requests), "requests that name the page in their referrer").toEqual([]);
}

function count(requests: readonly RecordedRequest[], pattern: RegExp): number {
  return requests.filter(({ url }) => pattern.test(url)).length;
}

test.describe("request allowlist @mock-api", () => {
  test("before any choice only the app shell, city list and manifest load", async ({ page }) => {
    const requests = await freshProfile(page);
    await chooseCity(page);
    await page.waitForTimeout(1_000);
    expectAllowed(page, requests, ["shell", "transit-data"]);
    // Transit data before the choice is the city list and its manifest only.
    const api = requests
      .map(({ url }) => new URL(url).pathname)
      .filter((path) => path.startsWith("/api/"));
    for (const path of api) expect(path).toMatch(/^\/api\/(cities|[a-z0-9-]+\/gtfs\/manifest)$/);
  });

  for (const preset of ["recommended", "strict"] as const) {
    for (const mode of ["Text", "Map"] as const) {
      test(`${preset} in ${mode} mode stays on the allowlist`, async ({ page }) => {
        const requests = await freshProfile(page);
        await finishSetup(page, preset, mode);
        await useApp(page, mode);

        const active = [
          ...NECESSARY,
          ...(mode === "Map" ? (["map-assets"] as const) : []),
          ...(preset === "recommended" ? LIVE : []),
        ];
        expectAllowed(page, requests, active);
        if (preset === "recommended") {
          expect(count(requests, /\/api\/[^/]+\/alerts$/)).toBeGreaterThan(0);
        }
        if (mode === "Text") {
          expect(count(requests, /maplibre|vendor-map|\/glyphs\/|\/micromap\//i)).toBe(0);
        }
      });
    }
  }

  test("one service turned on and off again connects only while it is on", async ({ page }) => {
    const requests = await freshProfile(page);
    await finishSetup(page, "strict", "Text");
    await useApp(page, "Text");
    expectAllowed(page, requests, NECESSARY);

    await page.goto("/settings");
    await page.getByRole("button", { name: /^Advanced/ }).click();
    const alerts = page.getByRole("radiogroup", { name: "Service alerts from the PTN operator" });
    await alerts.getByRole("radio", { name: "On" }).check();
    await expect(page.getByTestId("privacy-status-name")).toHaveText("Custom");

    const granted = requests.length;
    await page.goto("/");
    await openNearbyStop(page);
    await expect.poll(() => count(requests.slice(granted), /\/api\/[^/]+\/alerts$/)).toBeGreaterThan(0);
    // Only the granted service joins the necessary ones.
    expectAllowed(page, requests, [...NECESSARY, "operator.service-alerts"]);

    await page.goto("/settings");
    await page.getByRole("button", { name: /^Advanced/ }).click();
    await page
      .getByRole("radiogroup", { name: "Service alerts from the PTN operator" })
      .getByRole("radio", { name: "Off" })
      .check();
    const revoked = requests.length;
    await page.goto("/");
    await openNearbyStop(page);
    await page.waitForTimeout(1_500);
    expect(count(requests.slice(revoked), /\/api\/[^/]+\/alerts$/)).toBe(0);
    expectAllowed(page, requests.slice(revoked), NECESSARY);
  });
});

test.describe("request allowlist with the service worker @mock-api", () => {
  test.skip(
    process.env.E2E_PREVIEW !== "1",
    "needs the production build (pnpm build, then E2E_PREVIEW=1 with the offline project)",
  );

  for (const mode of ["Text", "Map"] as const) {
    test(`recommended in ${mode} mode stays on the allowlist under the service worker`, async ({ page }) => {
      const requests = await freshProfile(page);
      await finishSetup(page, "recommended", mode);
      // Let the first visit load the city's data before the worker takes over.
      await useApp(page, mode);
      await waitForActiveServiceWorker(page);
      // The second visit runs under the worker's control.
      await page.goto("/");
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
      await useApp(page, mode);
      expectAllowed(page, requests, [
        ...NECESSARY,
        ...LIVE,
        ...(mode === "Map" ? (["map-assets"] as const) : []),
      ]);
    });
  }
});
