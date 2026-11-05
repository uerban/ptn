// pt-wasm failure-path e2e.
//
// Pins the user-facing contract when the wasm engine can't initialise.
// `pt-wasm`/`pt-core` is the ONLY on-device engine — there is nothing to
// silently fall back to — so the planning boundary throws a typed engine error,
// NO itineraries render, and the hard `engine-error` surface appears.
//
// WHY THE FAILURE IS INJECTED AT THE WASM MODULE, NOT THE BUNDLE. These tests
// used to 503 `/api/<city>/raptor-bundle`. The PTB bytes ARE the catalog, so a
// 503 there is not "wasm is broken" — it is "there is no data", a different
// contract (pinned by its own test at the bottom). Breaking the `.wasm` module
// instead isolates the case under test exactly: catalog present, wasm engine
// unusable.
//
// Routes override pattern: `mockApi(page)` installs the happy-path stubs
// first; the per-test `page.route` call re-registers a matcher, and
// Playwright's last-write-wins semantics send matching requests to the
// override. `route.fallback()` hands back to mockApi's handler, which is how
// the brotli binary keeps being served while pt-wasm's is broken.
import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_STOP_QUERY, REF_FIXED_TIME } from "./route-overlay-refUrl";

// Engine failures only surface through a search — Search.tsx's auto-search
// effect early-returns when endpoints aren't set, so a bare `/` never reaches
// the planning boundary. Reuse the Vilnius stop-pair from REF_URL so the search
// actually fires and the wasm-init failure surfaces.

/**
 * Break pt-wasm's binary while leaving brotli-dec-wasm (the tile read path)
 * intact. Both are `.wasm`; only the URL tells them apart.
 */
async function breakPtWasmModule(
  page: import("@playwright/test").Page,
  mode: "unavailable" | "corrupt",
): Promise<void> {
  await page.route("**/*.wasm", (route) => {
    if (route.request().url().includes("brotli")) return route.fallback();
    if (mode === "unavailable") {
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    }
    // Four NUL bytes — not the `\0asm` magic, so `WebAssembly.instantiate`
    // rejects with a typed error rather than crashing the page.
    return route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: Buffer.from([0x00, 0x00, 0x00, 0x00]),
    });
  });
}

test.describe("wasm engine failure paths @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(REF_FIXED_TIME);
    await mockApi(page, { catalogNow: REF_FIXED_TIME });
  });

  test("when the wasm module is unavailable, the engine-error surface appears and no routes render", async ({
    page,
  }) => {
    await breakPtWasmModule(page, "unavailable");
    await page.goto(`/search?${REF_STOP_QUERY}`);
    await expect(page.locator("[data-testid='engine-error']")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-testid='itinerary-card']")).toHaveCount(0);
  });

  test("when the wasm module is corrupt, the engine-error surface appears and no routes render", async ({
    page,
  }) => {
    await breakPtWasmModule(page, "corrupt");
    await page.goto(`/search?${REF_STOP_QUERY}`);
    await expect(page.locator("[data-testid='engine-error']")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-testid='itinerary-card']")).toHaveCount(0);
  });

  // The catalog is fetched ONCE and feeds the single on-device engine: a happy
  // search must not double-fetch the bundle, and must not show an engine error.
  test("a healthy search fetches the catalog once and shows no engine error", async ({
    page,
  }) => {
    let bundleRequests = 0;
    await page.route("**/api/**/raptor-bundle", async (route) => {
      bundleRequests += 1;
      return route.fallback();
    });
    await page.goto(`/search?${REF_STOP_QUERY}`);
    await expect(page.locator("[data-testid='itinerary-card']").first()).toBeVisible({ timeout: 10_000 });
    expect(bundleRequests).toBe(1);
    await expect(page.locator("[data-testid='engine-error']")).toHaveCount(0);
  });

  // The PTB bytes are the ONLY catalog, so an unavailable bundle leaves the app
  // with no data to plan over at all. That must still fail softly — the
  // empty-result surface, not the hard engine-error one.
  test("an unavailable catalog bundle yields no itineraries without a hard error", async ({
    page,
  }) => {
    await page.route("**/api/**/raptor-bundle", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":{"code":"PTB_BUNDLE_UNAVAILABLE","message":"x"}}',
      }),
    );
    await page.goto(`/search?${REF_STOP_QUERY}`);
    await expect(page.locator("[data-testid='itinerary-card']")).toHaveCount(0);
    await expect(page.locator("[data-testid='engine-error']")).toHaveCount(0);
  });
});
