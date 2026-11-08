// Setup never asks for a browser permission by itself. Location is asked for
// only when the person presses "Use my location", and notifications are never
// asked for during setup or by the in-app alerts it turns on. Every state of
// both permissions (prompt, denied, granted) still reaches the app.
import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

type PermissionState = "prompt" | "denied" | "granted";

const VILNIUS = { latitude: 54.6872, longitude: 25.2797 };

// Start from no permissions at all; each test grants what it needs.
test.use({ permissions: [], geolocation: VILNIUS });

interface Calls {
  geolocation: number;
  notification: number;
}

/**
 * Count geolocation and notification permission requests, and present the
 * given states to the page. Denied location answers every request with
 * PERMISSION_DENIED, as a browser does after a refusal.
 */
async function instrument(page: Page, location: PermissionState, notification: PermissionState) {
  await page.addInitScript(
    ({ location, notification }) => {
      const calls = { geolocation: 0, notification: 0 };
      (window as unknown as { __permissionCalls: typeof calls }).__permissionCalls = calls;

      const geo = navigator.geolocation;
      const original = {
        getCurrentPosition: geo.getCurrentPosition.bind(geo),
        watchPosition: geo.watchPosition.bind(geo),
      };
      const deny = (error?: PositionErrorCallback | null) =>
        setTimeout(
          () => error?.({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
          0,
        );
      geo.getCurrentPosition = (success, error, options) => {
        calls.geolocation++;
        if (location === "denied") return deny(error);
        return original.getCurrentPosition(success, error, options);
      };
      geo.watchPosition = (success, error, options) => {
        calls.geolocation++;
        if (location === "denied") {
          deny(error);
          return 0;
        }
        return original.watchPosition(success, error, options);
      };

      const permission = notification === "prompt" ? "default" : notification;
      class StubNotification {
        static get permission() {
          return permission;
        }
        static requestPermission() {
          calls.notification++;
          return Promise.resolve(permission);
        }
        constructor() {}
      }
      Object.defineProperty(window, "Notification", { value: StubNotification, configurable: true });
    },
    { location, notification },
  );
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __permissionCalls: Calls }).__permissionCalls);

async function finishRecommendedSetup(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "How would you like to plan and explore?" })).toBeVisible();
  await page.getByRole("radio", { name: /Text mode/ }).check();
  await page.getByRole("button", { name: "Start with recommended settings" }).click();
  await expect(page.getByTestId("setup-shell")).toHaveCount(0);
  await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 15_000 });
}

test.describe("onboarding permissions @mock-api", () => {
  for (const state of ["prompt", "denied", "granted"] as const) {
    test(`location and notifications ${state}: setup asks for neither on its own`, async ({ page, context }) => {
      if (state === "granted") await context.grantPermissions(["geolocation", "notifications"]);
      await instrument(page, state, state);
      await mockApi(page, { setup: "fresh", realtime: "departures, alerts" });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Choose your city" })).toBeVisible();
      await page.waitForTimeout(500);
      expect(await calls(page)).toEqual({ geolocation: 0, notification: 0 });

      if (state === "prompt") {
        // Not pressing "Use my location" means no request at all.
        await page.getByRole("button", { name: /^Vilnius/ }).click();
      } else {
        await page.getByRole("button", { name: "Use my location" }).click();
        if (state === "denied") {
          await expect(page.getByText("Location is unavailable. Choose a city from the list.")).toBeVisible();
          // The list still works.
          await page.getByRole("button", { name: /^Vilnius/ }).click();
        }
        // Granted: the one city at the position is chosen.
      }
      expect((await calls(page)).geolocation).toBe(state === "prompt" ? 0 : 1);

      await finishRecommendedSetup(page);
      // Recommended turns on in-app service alerts, which never need the
      // browser's notification permission.
      await page.waitForTimeout(1_000);
      expect((await calls(page)).notification).toBe(0);
    });
  }
});
