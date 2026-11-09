// Service alerts on the surfaces that show them, and the ways the app asks
// about them: What's new for an existing installation, the inline row for a
// profile that left alerts undecided. Nothing asks the server for alerts
// before alerts are turned on.
import { test, expect, type Page } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";
import { RECOMMENDED_DECISIONS } from "../helpers/setup-complete";
import { LATEST_WHATS_NEW_ID } from "../../src/services/whatsNew.ts";

const ALERTS_URL = /\/api\/vilnius\/alerts(\?|$)/;

/** One severe alert for the default fixture's line r1 and the routing
 * fixture's stops S1/S3, so every surface has something to show. */
const ALERT = {
  id: "detour-1",
  cause: "CONSTRUCTION",
  effect: "DETOUR",
  severity: "SEVERE",
  header: [{ text: "Line diverted around the old town" }],
  description: [{ text: "Buses skip two stops while the street is closed." }],
  url: [{ text: "https://operator.example/alerts/detour-1" }],
  activePeriods: [],
  informedEntities: [{ routeId: "r1" }, { stopId: "S1" }, { stopId: "S3" }],
};

/** Serve the alerts endpoint and record every request to it. */
async function serveAlerts(page: Page): Promise<string[]> {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (ALERTS_URL.test(request.url())) calls.push(request.url());
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
        alerts: [ALERT],
      }),
    }),
  );
  return calls;
}

/**
 * A profile that finished setup with the given decisions, Text or Map mode,
 * and the city's alerts availability already known. Must run before
 * `mockApi` so its own setup seeding leaves this profile alone.
 */
async function seedProfile(
  page: Page,
  options: {
    decisions: Record<string, "allowed" | "denied">;
    textMode?: boolean;
    seenWhatsNew?: number;
    install?: "new" | "existing";
    /** Realtime kinds the city is already known to offer. */
    kinds?: string[];
  },
): Promise<void> {
  await page.addInitScript(
    ({ decisions, textMode, seenWhatsNew, install, kinds }) => {
      if (localStorage.getItem("ptn-onboarding")) return;
      localStorage.setItem(
        "ptn-onboarding",
        JSON.stringify({
          version: 1,
          install: { kind: install },
          decisions: { preset: "recommended", level: null, flows: {} },
          presentation: null,
          applied: true,
          legacyOverrides: {},
          seenWhatsNew,
          alertsNotNow: 0,
        }),
      );
      localStorage.setItem(
        "ptn-network-decisions",
        JSON.stringify({
          state: {
            decisions: Object.fromEntries(
              Object.entries(decisions).map(([flow, value]) => [
                flow,
                { value, source: "setup", decidedAt: 1 },
              ]),
            ),
          },
          version: 1,
        }),
      );
      localStorage.setItem(
        "ptn-realtime-availability",
        JSON.stringify({ vilnius: { kinds, seenAt: 1 } }),
      );
      if (textMode) {
        localStorage.setItem(
          "ptn-settings",
          JSON.stringify({ state: { scheduleMode: true }, version: 0 }),
        );
      }
    },
    {
      decisions: options.decisions,
      textMode: options.textMode ?? false,
      seenWhatsNew: options.seenWhatsNew ?? LATEST_WHATS_NEW_ID,
      install: options.install ?? "new",
      kinds: options.kinds ?? ["departures", "alerts"],
    },
  );
}

/** The service alerts choice in Settings. */
async function alertsSetting(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: /^Advanced/ }).click();
  return page.getByRole("radiogroup", { name: "Service alerts from the PTN operator" });
}

/** Text mode: open the departure sheet from the first nearby departure. */
async function openDepartureSheet(page: Page) {
  const row = page.getByTestId("nearby-departure").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const sheet = page.getByTestId("departure-sheet");
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  return sheet;
}

test.describe("Service alerts @mock-api", () => {
  test("recommended settings show alerts on nearby lines and the departure sheet", async ({ page }) => {
    await seedProfile(page, { decisions: RECOMMENDED_DECISIONS, textMode: true });
    await mockApi(page, { realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await page.goto("/");

    const affected = page.locator("[data-testid='nearby-departure'][aria-label*='Service alert']");
    await expect(affected.first()).toBeVisible({ timeout: 15_000 });
    await expect(affected.first().getByTestId("service-alert-indicator")).toBeVisible();
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) expect(new URL(url).search).toBe("");

    await affected.first().click();
    const sheet = page.getByTestId("departure-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    const item = sheet.getByTestId("service-alert");
    await expect(item).toContainText("Line diverted around the old town");
    await expect(item.getByTestId("service-alert-severity")).toHaveText("Severe");
    await expect(item.getByTestId("service-alert-link")).toHaveAttribute("target", "_blank");
    await expect(sheet.getByTestId("service-alerts-offer")).toHaveCount(0);
  });

  test("route results and trip guidance list the alert for the affected leg", async ({ page }) => {
    await seedProfile(page, { decisions: RECOMMENDED_DECISIONS });
    await mockApi(page, { routingFixture: "ptb-matched", realtime: "departures, alerts" });
    await serveAlerts(page);
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);

    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    const card = page.getByTestId("itinerary-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    const notes = page.getByTestId("service-alert-trip-notes").first();
    await expect(notes).toContainText("Line diverted around the old town", { timeout: 10_000 });

    await card.click();
    const explainer = page.getByTestId("trip-start-explainer");
    const steps = page.getByTestId("guidance-step-list");
    await expect(explainer.or(steps)).toBeVisible({ timeout: 10_000 });
    if (await explainer.isVisible()) await page.getByTestId("trip-start-confirm").click();
    await expect(steps.getByTestId("leg-service-alerts").first()).toContainText(
      "Line diverted around the old town",
      { timeout: 10_000 },
    );
    // The one spoken alert: severe, on the guided trip.
    await expect(page.getByTestId("service-alert-trip-announcer")).toHaveText(
      "Severe service alert on your trip: Line diverted around the old town",
    );
  });

  test("an undecided profile sees the inline row and asks nothing before Turn on", async ({ page }) => {
    await seedProfile(page, { decisions: { "operator.realtime": "allowed" } });
    await mockApi(page, { routingFixture: "ptb-matched", realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);

    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
    const offer = page.getByTestId("service-alerts-offer");
    await expect(offer).toContainText("Service alerts are available for");
    await expect(page.getByTestId("service-alert-trip-notes")).toHaveCount(0);
    expect(calls).toEqual([]);

    await offer.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByTestId("service-alert-trip-notes").first()).toBeVisible({ timeout: 10_000 });
    expect(calls.length).toBeGreaterThan(0);
    await expect(offer).toHaveCount(0);
  });

  test("an existing installation hears about alerts in What's new, once", async ({ page }) => {
    await seedProfile(page, { decisions: {}, textMode: true, seenWhatsNew: 0, install: "existing" });
    await mockApi(page, { realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await page.goto("/");

    const card = page.getByTestId("whats-new");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Service alerts");
    // Not modal and takes no focus.
    await expect(card).not.toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByTestId("nearby-departure").first().waitFor({ timeout: 15_000 });
    expect(calls).toEqual([]);

    await card.getByRole("button", { name: "Turn on" }).click();
    await expect(card).toContainText("Service alerts are on.");
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await card.getByRole("button", { name: "Close what's new" }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("nearby-departure").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("whats-new")).toHaveCount(0);
  });

  test("the map strip marks affected lines", async ({ page }) => {
    await seedProfile(page, { decisions: RECOMMENDED_DECISIONS });
    await mockApi(page, { realtime: "departures, alerts" });
    await serveAlerts(page);
    await page.goto("/");

    const card = page.locator("[data-testid='eta-card'][aria-label*='Service alert']").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("service-alert-indicator")).toBeVisible();
  });

  test("the line view lists the alert for its line", async ({ page }) => {
    await seedProfile(page, { decisions: RECOMMENDED_DECISIONS, textMode: true });
    await mockApi(page, { realtime: "departures, alerts" });
    await serveAlerts(page);
    await page.goto("/");

    const affected = page.locator("[data-testid='nearby-departure'][aria-label*='Service alert']");
    await expect(affected.first()).toBeVisible({ timeout: 15_000 });
    await affected.first().click();
    const sheet = page.getByTestId("departure-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.getByTestId("view-route-btn").first().click();
    await expect(page).toHaveURL(/\/line\//, { timeout: 10_000 });
    const panel = page.locator("[data-testid='service-alerts-panel'][data-surface='line-view']");
    await expect(panel).toHaveAttribute("data-state", "alerts", { timeout: 15_000 });
    await expect(panel.getByTestId("service-alert")).toContainText("Line diverted around the old town");
  });

  test("a first install skips What's new; strict setup offers alerts inline only", async ({ page }) => {
    await mockApi(page, { setup: "fresh", realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await page.goto("/");
    await page.getByRole("button", { name: /^Vilnius/ }).click();
    await page.getByRole("radio", { name: /Text mode/ }).check();
    await page.getByRole("button", { name: "Start with strict privacy" }).click();
    await expect(page.getByTestId("setup-shell")).toHaveCount(0);

    const sheet = await openDepartureSheet(page);
    await expect(page.getByTestId("whats-new")).toHaveCount(0);
    const offer = sheet.getByTestId("service-alerts-offer");
    await expect(offer).toContainText("Service alerts are available for");
    await expect(sheet.getByTestId("service-alert")).toHaveCount(0);
    expect(calls).toEqual([]);

    await offer.getByRole("button", { name: "Turn on" }).click();
    await expect(sheet.getByTestId("service-alert")).toContainText(
      "Line diverted around the old town",
      { timeout: 10_000 },
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  test("two Not now answers, in What's new and inline, end the asking", async ({ page }) => {
    await seedProfile(page, { decisions: {}, textMode: true, seenWhatsNew: 0, install: "existing" });
    await mockApi(page, { realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await page.goto("/");

    const card = page.getByTestId("whats-new");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole("button", { name: "Not now" }).click();
    await card.getByRole("button", { name: "Close what's new" }).click();
    await expect(card).toHaveCount(0);
    // The inline row stays away for the rest of this session.
    let sheet = await openDepartureSheet(page);
    await expect(sheet.getByTestId("service-alerts-offer")).toHaveCount(0);

    // A later session asks once more, inline.
    await page.reload();
    sheet = await openDepartureSheet(page);
    const offer = sheet.getByTestId("service-alerts-offer");
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Not now" }).click();
    await expect(offer).toHaveCount(0);

    // And then never again; Settings still has the choice.
    await page.reload();
    sheet = await openDepartureSheet(page);
    await expect(sheet.getByTestId("service-alerts-panel")).toHaveCount(0);
    await expect(page.getByTestId("whats-new")).toHaveCount(0);
    expect(calls).toEqual([]);
    const setting = await alertsSetting(page);
    await expect(setting.getByRole("radio", { name: "Ask first" })).toBeChecked();
  });

  test("turning alerts off in another tab stops polling here", async ({ page, context }) => {
    await page.clock.install();
    await seedProfile(page, { decisions: RECOMMENDED_DECISIONS, textMode: true });
    await mockApi(page, { realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await page.goto("/");
    const sheet = await openDepartureSheet(page);
    await expect(sheet.getByTestId("service-alert").first()).toBeVisible({ timeout: 10_000 });

    // Still polling while on: one more request a minute later.
    const first = calls.length;
    await page.clock.fastForward(61_000);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBeGreaterThan(first);

    const other = await context.newPage();
    await mockApi(other, { realtime: "departures, alerts" });
    const setting = await alertsSetting(other);
    await setting.getByRole("radio", { name: "Off" }).check();

    await expect(sheet.getByTestId("service-alert")).toHaveCount(0, { timeout: 10_000 });
    const after = calls.length;
    await page.clock.fastForward(61_000);
    await page.clock.fastForward(61_000);
    await page.waitForTimeout(1_000);
    expect(calls.length).toBe(after);
  });

  test("a city without alerts says so and asks for none", async ({ page }) => {
    await seedProfile(page, {
      decisions: RECOMMENDED_DECISIONS,
      textMode: true,
      kinds: ["departures"],
    });
    await mockApi(page, { realtime: "departures" });
    const calls = await serveAlerts(page);
    await page.goto("/");

    const sheet = await openDepartureSheet(page);
    const panel = sheet.getByTestId("service-alerts-panel");
    await expect(panel).toHaveAttribute("data-state", "unavailable");
    await expect(panel).toContainText("Vilnius does not publish service alerts to this app.");
    expect(calls).toEqual([]);
  });

  test("offline keeps the last alerts, marked stale, without a retry loop", async ({ page, context }) => {
    await page.clock.install();
    await seedProfile(page, { decisions: RECOMMENDED_DECISIONS, textMode: true });
    await mockApi(page, { realtime: "departures, alerts" });
    const calls = await serveAlerts(page);
    await page.goto("/");
    const sheet = await openDepartureSheet(page);
    await expect(sheet.getByTestId("service-alert").first()).toBeVisible({ timeout: 10_000 });

    await context.setOffline(true);
    await page.route(ALERTS_URL, (route) => route.abort("internetdisconnected"));
    const before = calls.length;
    await page.clock.fastForward(61_000);
    const panel = sheet.getByTestId("service-alerts-panel");
    await expect(panel).toHaveAttribute("data-state", "stale", { timeout: 10_000 });
    await expect(panel.getByTestId("service-alerts-status")).toContainText(
      "Alerts could not be refreshed",
    );
    await expect(panel.getByTestId("service-alert")).toContainText("Line diverted around the old town");

    // One attempt per retry interval, not a loop.
    await page.waitForTimeout(2_000);
    expect(calls.length - before).toBe(1);
    await page.clock.fastForward(31_000);
    await expect.poll(() => calls.length - before, { timeout: 10_000 }).toBe(2);
    await page.waitForTimeout(1_000);
    expect(calls.length - before).toBe(2);
    await expect(panel).toHaveAttribute("data-state", "stale");
  });
});
