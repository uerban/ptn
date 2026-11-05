import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Keyboard navigation @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("skip link focuses on Tab and jumps to #main-content on Enter", async ({ page }) => {
    await page.goto("/");

    const skipLink = page.getByTestId("skip-link");
    await expect(skipLink).toBeAttached();
    await expect(skipLink).toHaveAccessibleName(/\S/);

    await page.evaluate(() => {
      (document.body as HTMLElement).focus();
    });
    await page.keyboard.press("Tab");

    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/#main-content$/);

    const main = page.locator("main#main-content");
    await expect(main).toBeVisible();

    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.id))
      .toBe("main-content");
  });
});
