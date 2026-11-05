// The on-device engine runs in a dedicated worker, not on the page's main
// thread, so a search never blocks taps or scrolling. `buildPtRouter` falls
// back to an in-process router only where `Worker` does not exist; in a real
// browser that fallback must never be the path a search takes.
import { test, expect } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";

test.describe("wasm engine worker @mock-api", () => {
  test("a search plans in the router worker", async ({ page }) => {
    await mockApi(page, { routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
    await page
      .locator("[data-testid='itinerary-card']")
      .first()
      .waitFor({ timeout: 20_000 });

    const routerWorkers = page.workers().filter((w) => /ptRouter\.worker/.test(w.url()));
    expect(routerWorkers).toHaveLength(1);
  });
});
