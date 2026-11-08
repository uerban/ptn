// Text mode is a complete experience of its own: planning, departures, line
// details and trip guidance all work without the map module or its files.
// **Show map** opens a temporary map that Back to text and the browser's Back
// both leave, without changing the saved starting view.
import { test, expect, type Page, type Request } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";

/** Requests only the map needs: MapLibre, its worker, glyphs and tiles. */
const MAP_ONLY = /maplibre|vendor-map|\/glyphs\/|\.pbf(\?|$)|\/tiles?\//i;

function recordMapRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (req: Request) => {
    if (MAP_ONLY.test(req.url())) seen.push(req.url());
  });
  return seen;
}

async function startInTextMode(page: Page) {
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
    settings.state = { ...settings.state, scheduleMode: true };
    localStorage.setItem("ptn-settings", JSON.stringify(settings));
  });
}

async function savedScheduleMode(page: Page): Promise<unknown> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("ptn-settings") || "{}").state?.scheduleMode);
}

async function startFirstTrip(page: Page) {
  await page.getByTestId("itinerary-card").first().click();
  const explainer = page.getByTestId("trip-start-explainer");
  const guidance = page.getByTestId("text-guidance");
  await expect(explainer.or(guidance)).toBeVisible({ timeout: 10_000 });
  if (await explainer.isVisible()) await page.getByTestId("trip-start-confirm").click();
  await expect(guidance).toBeVisible({ timeout: 10_000 });
}

test.describe("Text mode @mock-api", () => {
  test("plans, inspects and starts a trip without loading the map", async ({ page }) => {
    const mapRequests = recordMapRequests(page);
    await mockApi(page, { routingFixture: "ptb-matched" });
    // Route shapes are missing: nothing in Text mode needs them.
    await page.route("**/gtfs/shapes/**", (route) => route.fulfill({ status: 404, body: "" }));
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await startInTextMode(page);

    await page.goto("/");
    await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 10_000 });

    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    const card = page.getByTestId("itinerary-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Times and transfers are in the card's accessible name.
    await expect(card).toHaveAttribute("aria-label", /\d{1,2}:\d{2}/);

    await startFirstTrip(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Trip guidance" })).toBeVisible();
    await expect(page.getByTestId("guidance-step-list")).toBeVisible();
    await expect(page.locator("canvas.maplibregl-canvas")).toHaveCount(0);
    expect(mapRequests).toEqual([]);
  });

  test("departures say Live only for real-time data, with direction and stop", async ({ page }) => {
    const mapRequests = recordMapRequests(page);
    await mockApi(page);
    await startInTextMode(page);
    await page.goto("/");

    const rows = page.getByTestId("nearby-departure");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-testid='nearby-departure'][data-status='live']")).toHaveAttribute(
      "aria-label",
      /^Line \S+ toward .+, from .+, (in \d+ min|due now), Live$/,
    );
    await expect(page.locator("[data-testid='nearby-departure'][data-status='scheduled']").first()).toHaveAttribute(
      "aria-label",
      /, Scheduled$/,
    );
    // Countdowns are not announced as they tick.
    await expect(page.getByTestId("nearby-departures").locator("[aria-live]")).toHaveCount(0);

    // A departure opens its stop's departures; a line opens its own page.
    await rows.first().click();
    const sheet = page.getByTestId("departure-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    const viewRoute = sheet.getByTestId("view-route-btn").first();
    await expect(viewRoute).toBeVisible({ timeout: 10_000 });
    await viewRoute.click();
    await expect(page).toHaveURL(/\/line\/[^/?]+\?dir=\d/, { timeout: 10_000 });
    expect(mapRequests).toEqual([]);
  });

  test("without real-time data every departure is labelled Scheduled", async ({ page }) => {
    await mockApi(page);
    await page.route("**/gtfs/rt-tile/**", (route) => route.fulfill({ status: 503, body: "" }));
    await startInTextMode(page);
    await page.goto("/");
    await expect(page.getByTestId("nearby-departure").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-testid='nearby-departure'][data-status='live']")).toHaveCount(0);
  });

  test("Show map is temporary: Back to text and browser Back return focus to it", async ({ page }) => {
    const mapRequests = recordMapRequests(page);
    await mockApi(page);
    await startInTextMode(page);
    await page.goto("/");
    const textMain = page.locator("section[aria-label='Text mode']");
    await expect(textMain).toBeVisible({ timeout: 10_000 });
    const showMap = page.getByTestId("show-map-btn");

    // The one-time download is disclosed at the action.
    await showMap.click();
    const disclosure = page.getByRole("dialog", { name: "Show a map?" });
    await expect(disclosure).toContainText("downloaded once");
    await disclosure.getByRole("button", { name: "Cancel" }).click();
    await expect(disclosure).toHaveCount(0);
    await expect(showMap).toBeFocused();
    expect(mapRequests).toEqual([]);

    await showMap.click();
    await page.getByRole("button", { name: "Download and show map" }).click();
    await expect(page).toHaveURL(/\?view=map$/);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible({ timeout: 15_000 });
    expect(mapRequests.length).toBeGreaterThan(0);
    expect(await savedScheduleMode(page)).toBe(true);

    await page.getByTestId("back-to-text-btn").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(textMain).toBeVisible();
    await expect(showMap).toBeFocused();

    await showMap.click();
    await page.getByRole("button", { name: "Download and show map" }).click();
    await expect(page.getByTestId("back-to-text-btn")).toBeVisible({ timeout: 15_000 });
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(textMain).toBeVisible();
    await expect(showMap).toBeFocused();
    expect(await savedScheduleMode(page)).toBe(true);

    // A reload keeps the saved starting view.
    await page.reload();
    await expect(textMain).toBeVisible({ timeout: 10_000 });
  });

  test("with no position, stops are chosen by name and nothing claims to be nearby", async ({ page, context }) => {
    await context.clearPermissions();
    await mockApi(page);
    await startInTextMode(page);
    await page.goto("/");

    await expect(page.getByTestId("nearby-no-location")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("stop-distance")).toHaveCount(0);
    await expect(page.getByTestId("nearby-departures")).toHaveCount(0);

    await page.getByTestId("nearby-stop-filter").fill("Xanadu");
    const cards = page.getByTestId("stop-card");
    await expect(cards).toHaveCount(1);
    await cards.first().getByTestId("stop-name").click();
    await expect(page.getByTestId("departure-sheet")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("sheet-close").click();

    // The chosen stop anchors the list and the departures, by name.
    await expect(page.getByRole("heading", { name: /^Departures near Xanadu Return-Only$/ })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("list", { name: /^Stops near Xanadu Return-Only$/ })).toBeVisible();
    await expect(page.getByText("Departures near you")).toHaveCount(0);
  });

  test("works by keyboard alone at large text sizes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await startInTextMode(page);
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = "200%";
      });
    });
    await page.goto("/");
    await expect(page.getByTestId("nearby-departure").first()).toBeVisible({ timeout: 15_000 });

    // No sideways scrolling at 200% text.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Reach Show map with Tab, open and dismiss its disclosure by keyboard.
    const showMap = page.getByTestId("show-map-btn");
    for (let i = 0; i < 40 && !(await showMap.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(showMap).toBeFocused();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("button", { name: "Download and show map" });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(showMap).toBeFocused();

    // A departure opens by keyboard too.
    const departure = page.getByTestId("nearby-departure").first();
    await departure.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("departure-sheet")).toBeVisible({ timeout: 10_000 });
  });

  test("starts guidance by keyboard", async ({ page }) => {
    await mockApi(page, { routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await startInTextMode(page);
    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    const card = page.getByTestId("itinerary-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.focus();
    await page.keyboard.press("Enter");
    const explainer = page.getByTestId("trip-start-explainer");
    const guidance = page.getByTestId("text-guidance");
    await expect(explainer.or(guidance)).toBeVisible({ timeout: 10_000 });
    if (await explainer.isVisible()) {
      await expect(page.getByTestId("trip-start-confirm")).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect(guidance).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("guidance-show-map-btn")).toBeVisible();
  });
});

test.describe("Text mode production build @offline", () => {
  test.use({ serviceWorkers: "allow" });
  test.skip(
    process.env.E2E_PREVIEW !== "1" && !process.env.E2E_BASE_URL,
    "needs the production build (pnpm build, then E2E_PREVIEW=1)",
  );

  test("plans and starts guidance with the service worker on and no map files", async ({ page }) => {
    const mapRequests = recordMapRequests(page);
    await mockApi(page, { routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await startInTextMode(page);

    await page.goto("/");
    await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 15_000 });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Second load runs under the service worker's control.
    await page.reload();
    await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
    await startFirstTrip(page);
    await expect(page.getByTestId("guidance-step-list")).toBeVisible();

    expect(mapRequests).toEqual([]);
    const cachedMapFiles = await page.evaluate(async () => {
      if (!(await caches.has("map-assets"))) return 0;
      return (await (await caches.open("map-assets")).keys()).length;
    });
    expect(cachedMapFiles).toBe(0);
  });
});
