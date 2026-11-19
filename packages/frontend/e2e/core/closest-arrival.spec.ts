import { expect, test } from "@playwright/test";
import { setFixedDate } from "../helpers/fixed-date";
import { mockApi, PTB_MATCHED_FIXED_TIME, PTB_MATCHED_STOP_QUERY } from "../helpers/mock-api";

test.use({ timezoneId: "Europe/Vilnius" });

const closestEnabled = process.env.VITE_PTN_CLOSEST_ARRIVAL === "1";
const arriveByRequired = process.env.PTN_ARRIVE_BY_EXPERIMENT === "1" || closestEnabled;

test("Arrive By respects the Closest arrival flag @mock-api", async ({ page }) => {
  test.setTimeout(60_000);
  await mockApi(page, { routingFixture: "ptb-matched" });
  await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
  await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
  await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 30_000 });

  const when = page.getByTestId("when-summary");
  test.skip(!arriveByRequired && await when.count() === 0, "This build does not include Arrive By");
  await when.click();
  await page.getByRole("button", { name: "Arrive by", exact: true }).click();
  await page.getByTestId("arrive-by-date").fill("2026-05-05");
  // The picker uses Vilnius time while this PTB fixture is generated in UTC.
  await page.getByTestId("arrive-by-time").fill("11:11");
  await page.getByTestId("arrive-by-apply").click();

  const results = page.getByTestId("arrive-by-results");
  const closest = results.getByRole("button", { name: "Closest arrival", exact: true });
  const cards = results.getByTestId("itinerary-card");
  await expect(results).toHaveAttribute("data-status", "complete", { timeout: 25_000 });

  if (!closestEnabled) {
    await expect(closest).toHaveCount(0);
    await expect(cards.first()).toBeVisible();
    return;
  }

  await closest.click();
  await expect(closest).toHaveAttribute("aria-pressed", "true");
  await expect(results.getByRole("status")).toContainText("Closest arrival by", { timeout: 25_000 });
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(/0?8:10/);
  expect(page.workers().some((worker) => /ptArriveByOwner\.worker/.test(worker.url()))).toBe(true);

  await closest.click();
  await expect(results.getByRole("status")).toContainText("latest departure first", { timeout: 25_000 });
});
