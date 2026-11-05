import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * Negative-test fixture for TS-081 (privacy: nearby stops never leak
 * coordinates).
 *
 * This spec deliberately introduces a regression: it routes the same
 * flow as TS-081 but adds a `/api/**\/stops/nearby?lat=…&lon=…` request
 * that carries the user's GPS. If the privacy interceptor in
 * `privacy-nearby.spec.ts` is doing its job, that interceptor would
 * fail when run against a similarly-instrumented session — but we
 * can't easily run two fixtures back-to-back inside one Playwright
 * test. Instead, we duplicate the privacy gate inline here and assert
 * that THIS gate fires, proving the gate's regex catches a real leak.
 *
 * It is `.skip`-ped by default so CI never runs it. Run locally via:
 *
 *     pnpm --filter @pt/frontend playwright test \
 *       --project=pr-chromium --grep @regression-fixture \
 *       e2e/core/privacy-nearby.regression.spec.ts
 *
 * Expected behaviour: the test FAILS with "Coord leak in request URL"
 * (or similar). A passing run means the interceptor is NOT catching
 * leaks and the privacy assertion needs to be tightened.
 */

const USER_LAT = 54.68735;
const USER_LON = 25.27985;

function normalize(s: string): string {
  let out = s;
  try {
    out = decodeURIComponent(out);
  } catch {
    // ignore
  }
  return out.toLowerCase().replace(/\s+/g, "");
}

const LAT_PATTERN = /54\.68735/;
const LON_PATTERN = /25\.27985/;

test.describe("Privacy regression fixture @regression-fixture", () => {
  // ============================================================
  // DO NOT REMOVE the `.skip` below — this is an INTENTIONAL FAILURE.
  //
  // The skip is the contract: this test exists to be unskipped LOCALLY
  // to verify the production privacy interceptor (privacy-nearby.spec.ts)
  // catches a real coordinate leak. When unskipped, it MUST FAIL.
  //
  // If a future contributor edits this file and CI starts running this
  // test, CI will be red (intentionally). Restore `.skip` to fix.
  // ============================================================
  test.skip(
    "INTENTIONAL: leaks coords (used to verify TS-081 catches regressions)",
    async ({ page, context }) => {
      await context.grantPermissions(["geolocation"]);
      await context.setGeolocation({
        latitude: USER_LAT,
        longitude: USER_LON,
      });

      const capturedRequests: { url: string; postData: string | null }[] = [];
      page.on("request", (req) => {
        const url = req.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return;
        capturedRequests.push({ url, postData: req.postData() });
      });

      // Stub the nearby route so the synthetic fetch below resolves.
      // Either this handler or mockApi's wins (Playwright runs the
      // last-registered match first), so we don't depend on ordering
      // for leak detection — page.on("request") captures the URL
      // regardless of which fulfill() ultimately runs.
      await page.route("**/api/**/stops/nearby*", (route) =>
        route.fulfill({ json: { data: [] } }),
      );

      await mockApi(page);

      // Force a nearby fetch by going to schedule mode
      await page.addInitScript(() => {
        const settings = JSON.parse(
          localStorage.getItem("ptn-settings") || "{}",
        );
        settings.state = { ...settings.state, scheduleMode: true };
        localStorage.setItem("ptn-settings", JSON.stringify(settings));
      });

      await page.goto("/");
      await page.waitForTimeout(3000);

      // Manually issue a request that carries the coords — this is
      // the leak we're verifying the interceptor catches. Without
      // this synthetic call the spec might "pass" simply because the
      // app already does the right thing.
      await page.evaluate(
        async ({ lat, lon }) => {
          await fetch(`/api/vilnius/stops/nearby?lat=${lat}&lon=${lon}`);
        },
        { lat: USER_LAT, lon: USER_LON },
      );

      // Run the same gate as privacy-nearby.spec.ts. This MUST fire
      // — if it doesn't, our regex is too lax.
      let leakDetected = false;
      for (const req of capturedRequests) {
        const normUrl = normalize(req.url);
        if (LAT_PATTERN.test(normUrl) && LON_PATTERN.test(normUrl)) {
          leakDetected = true;
          break;
        }
      }

      expect(
        leakDetected,
        "Privacy regex should have caught the synthetic coord leak. " +
          "If this fails, the LAT_PATTERN/LON_PATTERN in privacy-nearby.spec.ts " +
          "needs tightening.",
      ).toBe(true);

      // Now intentionally fail to satisfy the "negative test" contract:
      // a passing assertion means the gate caught the leak. Re-fire the
      // assertion in the form the production spec uses so a developer
      // running this fixture sees the SAME failure shape they'd see
      // on a real privacy regression.
      for (const req of capturedRequests) {
        const normUrl = normalize(req.url);
        if (LAT_PATTERN.test(normUrl) && LON_PATTERN.test(normUrl)) {
          expect.fail(`Coord leak in request URL: ${req.url}`);
        }
      }
    },
  );
});
