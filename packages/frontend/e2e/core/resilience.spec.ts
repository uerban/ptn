// Text planning and core use survive the things that can go wrong around
// them: no WebGL, storage that refuses writes, a privacy migration that cannot
// be saved, switching city, and entering on a deep link. No map dependency may
// block planning, and no failed privacy migration may block core use. The
// offline installed city runs under the service worker in offline.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";

test.use({ permissions: [] });

async function expectPlanning(page: Page): Promise<void> {
  await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
  await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
}

async function expectInApp(page: Page): Promise<void> {
  await expect(page.getByTestId("setup-shell")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
}

/** Make localStorage refuse writes to the matching keys, as a full disk does. */
async function refuseWrites(page: Page, keys: RegExp): Promise<void> {
  await page.addInitScript((source) => {
    const pattern = new RegExp(source);
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && pattern.test(key)) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  }, keys.source);
}

test.describe("resilience @mock-api", () => {
  test("without WebGL, Map mode still opens and plans a journey", async ({ page }) => {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof getContext;
    });
    await mockApi(page, { routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await page.goto("/");
    await expectInApp(page);
    await expectPlanning(page);
  });

  test("storage that refuses every write still completes setup and plans", async ({ page }) => {
    await mockApi(page, { setup: "fresh", routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await refuseWrites(page, /^ptn-/);
    await page.goto("/");
    await page.getByRole("button", { name: /^Vilnius/ }).click();
    await page.getByRole("radio", { name: /Text mode/ }).check();
    await page.getByRole("button", { name: "Start with strict privacy" }).click();
    await expectInApp(page);
    // Planning in the same session, without a reload that would lose setup.
    await page.getByRole("link", { name: "Settings" }).click();
    await page.evaluate((query) => {
      history.pushState({}, "", `/search?${query}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, PTB_MATCHED_STOP_QUERY);
    await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
  });

  test("a privacy migration that cannot be saved does not block core use", async ({ page }) => {
    await mockApi(page, { setup: "fresh", routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    // An existing installation from before the update…
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "vilnius" } }, version: 0 }));
        localStorage.setItem("ptn-settings", JSON.stringify({ state: { scheduleMode: true }, version: 0 }));
        localStorage.setItem("ptn-privacy", JSON.stringify({ state: { level: "enhanced" }, version: 0 }));
      }
    });
    // …whose new records cannot be written.
    await refuseWrites(page, /^ptn-(onboarding|network-decisions)$/);
    await page.goto("/");
    await expectInApp(page);
    await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 15_000 });
    await expectPlanning(page);
  });

  test("switching city keeps the privacy choices and planning", async ({ page }) => {
    await mockApi(page, { realtime: "departures, alerts", routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await page.goto("/settings");
    const before = await page.evaluate(() => localStorage.getItem("ptn-network-decisions"));
    await page.getByRole("button", { name: /^Advanced/ }).click();
    const picker = page.getByRole("combobox", { name: "City to download" });
    const other = await picker.locator("option:not([value='vilnius'])").first().getAttribute("value");
    await picker.selectOption(other!);
    await page.getByRole("button", { name: "Open and download" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = JSON.parse(localStorage.getItem("ptn-city") ?? "{}").state;
          return state?.currentCityId ?? state?.activeCity?.id;
        }),
      )
      .toBe(other);
    expect(await page.evaluate(() => localStorage.getItem("ptn-network-decisions"))).toBe(before);
    await expect(page.getByTestId("setup-shell")).toHaveCount(0);
    await expectPlanning(page);
  });

  test("a deep link into a finished profile plans without passing through setup", async ({ page }) => {
    await mockApi(page, { routingFixture: "ptb-matched" });
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await expectPlanning(page);
    await expect(page).toHaveURL(new RegExp(`/search\\?${PTB_MATCHED_STOP_QUERY}$`));
    await expect(page.getByTestId("setup-shell")).toHaveCount(0);
  });
});
