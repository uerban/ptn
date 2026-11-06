import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mockApi } from "../helpers/mock-api";

// The perf project pins Chromium with --enable-precise-memory-info, so
// performance.memory is a hard requirement. Missing API means the project
// config was broken — fail loud rather than silently skip.
const JS_HEAP_BUDGET_MB = 100;

test.describe("@perf memory budgets", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await mockApi(page);
    await page.goto("/");
  });

  test("JS heap stays under budget after initial load", async ({ page }) => {
    // Anchor measurement on an observable app-ready state (map handle present
    // AND the stops GeoJSON source has rendered features). This ensures we're
    // measuring the full init workload, not mid-render.
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __ptnMap?: { getSource?: (id: string) => unknown; querySourceFeatures?: (id: string) => unknown[] } };
        const map = w.__ptnMap;
        if (!map?.getSource) return false;
        const source = map.getSource("stops-source");
        return source != null && (map.querySourceFeatures?.("stops-source") ?? []).length > 0;
      },
      undefined,
      { timeout: 20_000, polling: 300 },
    );
    // Short settle window to let GC run after the init burst — the anchor
    // above already handles the timing-of-load problem.
    await page.waitForTimeout(500);

    const heapBytes = await page.evaluate(() => {
      const p = performance as Performance & { memory?: { usedJSHeapSize: number } };
      return p.memory?.usedJSHeapSize ?? null;
    });

    // The perf project is Chromium + --enable-precise-memory-info; a null here
    // means the launch flag didn't apply or the project picked up a wrong
    // engine. That's a config regression, not something to silently skip.
    expect(
      heapBytes,
      "performance.memory.usedJSHeapSize missing — check playwright.config.ts perf-project launch args",
    ).not.toBeNull();

    const heapMB = (heapBytes as number) / (1024 * 1024);

    // Write a stable metrics file the CI summary aggregator can pick up.
    // testInfo.attach() is cleaned up on passing tests, so we persist to a
    // known path under test-results/ that the upload-artifact step collects.
    const metricsPath = resolve("test-results/perf-metrics/heap.json");
    mkdirSync(dirname(metricsPath), { recursive: true });
    writeFileSync(
      metricsPath,
      JSON.stringify({
        metric: "js-heap-mb",
        value: Number(heapMB.toFixed(2)),
        budget: JS_HEAP_BUDGET_MB,
        timestamp: new Date().toISOString(),
      }, null, 2),
    );
    console.log(`JS heap: ${heapMB.toFixed(1)}MB (budget ${JS_HEAP_BUDGET_MB}MB)`);

    expect(
      heapMB,
      `JS heap ${heapMB.toFixed(1)}MB exceeds budget ${JS_HEAP_BUDGET_MB}MB`,
    ).toBeLessThan(JS_HEAP_BUDGET_MB);
  });

  // TODO(us094-task-followup): an IndexedDB quota assertion was drafted in
  // PR #41 but removed because the current mock-api flow doesn't seed Dexie
  // with GTFS data — usage is ~0MB and the assertion (`< 80MB`) was trivially
  // true, providing false confidence. Land alongside a real-data seeding
  // fixture: then assert both a lower bound (IDB writes happened) and an
  // upper bound (no runaway growth).
});
