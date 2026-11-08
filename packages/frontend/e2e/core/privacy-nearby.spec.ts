import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

// User's simulated GPS coordinates -- we verify these never appear in requests
const USER_LAT = 54.68735;
const USER_LON = 25.27985;
const PUBLIC_STOP_LAT = 54.6872;
const PUBLIC_STOP_LON = 25.2797;

/**
 * Normalize a URL or request body to a form that catches URL-encoded
 * (`54%2E687`), case-mixed (`Lat=54.6872`), and whitespace-padded
 * variants. The substring check on its own missed those.
 */
function normalize(s: string): string {
  let out = s;
  // decodeURIComponent throws on stray %; coerce safely.
  try {
    out = decodeURIComponent(out);
  } catch {
    // Already-bad URI escapes — fall through with raw string.
  }
  return out.toLowerCase().replace(/\s+/g, "");
}

/**
 * Match the exact simulated measurement without also matching the deliberately
 * nearby public stop centroid used by the endpoint assertion below.
 */
const RAW_LAT_PATTERN = /54\.68735/;
const RAW_LON_PATTERN = /25\.27985/;

/**
 * A request to a nearby-stops API route: `/api/<city>/stops/nearby`, or a bare
 * `/api/<city>/nearby`. Matched on path segments, not substrings: a substring
 * test also caught dev-server module loads such as
 * `/src/services/nearbyDirections.ts`, and every `/@fs/` load from a checkout
 * whose path contains "nearby".
 */
function isNearbyApiCall(rawUrl: string): boolean {
  const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
  return segments.includes("api") && segments[segments.length - 1] === "nearby";
}

test.describe("Privacy: nearby stops @mock-api", () => {
  // TS-081: Nearby stops computed client-side
  test("TS-081: no user coordinates sent to server for nearby stops", async ({
    page,
    context,
  }) => {
    // Set known geolocation
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({
      latitude: USER_LAT,
      longitude: USER_LON,
    });

    await mockApi(page);

    // Intercept ALL outbound requests and record URLs + post data
    const capturedRequests: { url: string; postData: string | null }[] = [];
    page.on("request", (req) => {
      // Skip data: URLs and blob: URLs (internal browser resources)
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      capturedRequests.push({
        url,
        postData: req.postData(),
      });
    });

    // Enable schedule mode (uses NearbyStopsList with client-side computation)
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
      settings.state = { ...settings.state, scheduleMode: true };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });

    // Load the app
    await page.goto("/");

    // Wait for schedule view to render
    await expect(
      page.locator("main[aria-label='Text mode']"),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for nearby stops to be computed and rendered
    // Either the list appears, or the empty/loading state resolves
    await page.waitForTimeout(5000);

    // Assert: no request URL or body contains user coordinates.
    // Normalize first so URL-encoded, case-mixed, and whitespace-injected
    // forms of the exact simulated measurement cannot slip past.
    for (const req of capturedRequests) {
      const normUrl = normalize(req.url);
      if (RAW_LAT_PATTERN.test(normUrl) && RAW_LON_PATTERN.test(normUrl)) {
        expect.fail(`Coord leak in request URL: ${req.url}`);
      }

      if (req.postData) {
        const normBody = normalize(req.postData);
        if (RAW_LAT_PATTERN.test(normBody) && RAW_LON_PATTERN.test(normBody)) {
          expect.fail(
            `Coord leak in request body. URL: ${req.url}, body: ${req.postData}`,
          );
        }
      }
    }

    // Assert: no request to a "nearby" endpoint was made
    // (Schedule mode loads from IndexedDB, not API)
    const nearbyApiCalls = capturedRequests.filter((req) => isNearbyApiCall(req.url));

    expect(
      nearbyApiCalls,
      "No API calls to /stops/nearby should be made -- nearby stops are computed client-side from IndexedDB",
    ).toHaveLength(0);
  });

  test("TS-081: map mode sends only the nearest public stop centroid, only on Locate me", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({
      latitude: USER_LAT,
      longitude: USER_LON,
    });

    const nearbyUrls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/stops/nearby")) {
        nearbyUrls.push(request.url());
      }
    });

    await mockApi(page);
    const allStops = page.waitForResponse((response) =>
      response.url().includes("/stops/all"),
    );
    await page.goto("/");
    await allStops;
    // Passive tracking (preapproved GPS) must never query the server.
    await expect(page.locator(".user-position-marker")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    expect(nearbyUrls).toHaveLength(0);
    // Only an explicit Locate me may send the public stop centroid.
    await page.locator(".maplibregl-ctrl-geolocate").click();
    await expect.poll(() => nearbyUrls.length).toBe(1);
    for (const rawUrl of nearbyUrls) {
      const url = new URL(rawUrl);
      expect(url.searchParams.get("lat")).toBe(String(PUBLIC_STOP_LAT));
      expect(url.searchParams.get("lon")).toBe(String(PUBLIC_STOP_LON));
      expect(url.searchParams.get("lat")).not.toBe(String(USER_LAT));
      expect(url.searchParams.get("lon")).not.toBe(String(USER_LON));
    }
  });
});
