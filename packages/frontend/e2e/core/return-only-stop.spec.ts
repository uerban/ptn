import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

// Regression coverage for return-only stops on bidirectional routes:
// the raptor-data fixture seeds route "1" with two `directionPatterns`
// where stop "test-X" only appears on the inbound pattern (canonical
// `stopIds` is `[test-A, test-B]`). Before the sibling-surface migration,
// `route.stopIds.indexOf("test-X")` returned -1 and the schedule-view
// stop card hid line "1" entirely. This spec drives schedule mode end-
// to-end against the mocked feed and asserts the stop card at stop X
// surfaces line "1" with the inbound terminal as its direction label.
test.describe("Return-only stop on bidirectional route @mock-api", () => {
  test("schedule view surfaces line 1 with inbound direction at return-only stop", async ({
    page,
    context,
  }) => {
    // Park the simulated user at stop X so it appears at the top of the
    // distance-sorted nearby list.
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 54.6874, longitude: 25.2802 });

    await mockApi(page);

    // Enable schedule mode so NearbyStopsList drives the surface (uses
    // `directionResolver` + `routesAtStop` — the sibling surfaces under
    // migration).
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
      settings.state = { ...settings.state, scheduleMode: true };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });

    await page.goto("/");

    await expect(
      page.locator("section[aria-label='Text mode']"),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for GTFS sync to populate stopGroups in IndexedDB and the list
    // to render.
    const list = page.locator("[data-testid='nearby-stops-list']");
    await expect(list).toBeVisible({ timeout: 15_000 });

    // Locate the stop card by its name. The fixture names X "Xanadu
    // Return-Only" so the match is unambiguous against the existing
    // Vilnius stops.
    const xCard = page
      .locator("[data-testid='stop-card']")
      .filter({ hasText: "Xanadu Return-Only" });
    await expect(xCard).toBeVisible({ timeout: 10_000 });

    // Departure card surfaces route "1": line-badge text equals "1".
    // Without the routesAtStop union (raptorIndex.hydrate) plus the
    // directionPattern fallback, line "1" would not appear here.
    const lineOne = xCard.locator("[data-testid='line-badge']", {
      hasText: /^1$/,
    });
    await expect(lineOne).toBeVisible();

    // Direction label must show the inbound terminal ("Alpha Terminal"),
    // not the outbound headsign ("Bravo Center"). Before the
    // directionResolver migration, route.trips[0].headsign would have
    // leaked the outbound label everywhere.
    const directionLabel = xCard.locator("[data-testid='direction-label']");
    await expect(directionLabel).toContainText("Alpha Terminal");
    await expect(directionLabel).not.toContainText("Bravo Center");
  });
});
