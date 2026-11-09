import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ZOOM_CARDS_MIN, ZOOM_LABELS_MIN } from "@pt/shared";
import { seedCompletedSetup } from "../helpers/setup-complete";

// City switching and viewport panning against two synthetic cities served by
// the real producer and pt-serve (scripts/regression/synthetic_cities.py).
// Ported from scripts/diagnostics/city-switch.cjs; see
// docs/diagnostics/city-switch-performance for the original investigation.
//
// The tests fail on behaviour that made switching slow: legacy timetable
// projection writes, activations or badges that never settle, page errors.
// Timings are recorded for calibration only. The investigation's 1 s budget
// was measured on desktop GPU hardware; CI renders in software.

const CATALOG = process.env.PTN_SYNTHETIC_CITIES;
const SWITCHES = Number(process.env.PTN_CITY_SWITCHES ?? 12);
const STEP_TIMEOUT_MS = 60_000;
// The six-table projection copy plus stop groups: the fixed slow path rewrote
// these on every switch. Startup may clear them once (legacy cleanup); after
// the first city is ready, nothing may write them, and the projection-write
// stage (services/gtfsSync.ts) must never run.
const PROJECTION_STAGES = ["ptn:city:projection-write", "ptn:city:trip-write"];
const LEGACY_PROJECTION_TABLES = [
  "gtfsRoutes", "gtfsTrips", "gtfsServices", "gtfsStops", "gtfsShapes", "gtfsSyncMeta", "stopGroups",
];

interface City {
  id: string;
  name: string;
  tz: string;
  center: { lat: number; lon: number };
  bbox: Record<string, number>;
  apiOrigin: string;
  auxOrigin: string;
}

const cities: City[] = CATALOG ? JSON.parse(readFileSync(CATALOG, "utf8")).cities : [];

function writeMetrics(name: string, value: unknown) {
  const path = resolve(`test-results/perf-metrics/${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

const quantile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
};
const distribution = (values: number[]) => ({
  samples: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95),
  max: values.length ? Math.max(...values) : null,
});

async function routeSyntheticApi(page: Page) {
  const byId = new Map(cities.map(city => [city.id, city]));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const [, api, cityId, ...rest] = url.pathname.split("/");
    const city = api === "api" ? byId.get(cityId) : undefined;
    if (!city) return route.fulfill({ status: 404, json: { error: "not found" } });
    const tail = rest.join("/");
    // examples/native/Caddyfile routes these to the auxiliary listener.
    const target = /^(health|ready|version)$/.test(tail)
      ? `${city.auxOrigin}/${tail}${url.search}`
      : `${city.apiOrigin}${url.pathname}${url.search}`;
    return route.fulfill({ response: await route.fetch({ url: target }) });
  });
  await page.route("**/api/cities", route => route.fulfill({ json: {
    schemaVersion: 2,
    cities: cities.map(({ id, name, tz, center, bbox }) => ({ id, name, tz, center, bbox })),
  } }));
}

async function instrument(page: Page, errors: string[]) {
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(({ tables, stageNames }) => {
    const w = window as unknown as Record<string, unknown>;
    const writes: { stores: string[]; at: number }[] = [];
    const longTasks: { startTime: number; duration: number }[] = [];
    const stages: { name: string; startTime: number; duration: number }[] = [];
    w.__gateProjectionWrites = writes;
    w.__gateProjectionStages = stages;
    w.__gateLongTasks = longTasks;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...params: Parameters<IDBDatabase["transaction"]>) {
      const tx = original.apply(this, params);
      const stores = Array.from(tx.objectStoreNames).filter(name => tables.includes(name));
      if (params[1] === "readwrite" && stores.length) writes.push({ stores, at: performance.now() });
      return tx;
    } as IDBDatabase["transaction"];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }).observe({ entryTypes: ["longtask"] });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (stageNames.includes(entry.name)) stages.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ entryTypes: ["measure"] });
  }, { tables: LEGACY_PROJECTION_TABLES, stageNames: PROJECTION_STAGES });
}

async function openFirstCity(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __ptnMap?: unknown }).__ptnMap, null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(cityId => performance.getEntriesByName("ptn:city:index-build")
    .some(entry => (entry as PerformanceMeasure).detail?.cityId === cityId && (entry as PerformanceMeasure).detail?.outcome === "complete"),
  cities[0].id, { timeout: STEP_TIMEOUT_MS });
  await page.evaluate(() => { (window as unknown as { __gateReadyAt: number }).__gateReadyAt = performance.now(); });
}

/** Projection stages at any time, and legacy table writes after the first city was ready. */
async function projectionWrites(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __gateReadyAt: number; __gateProjectionStages: unknown[];
      __gateProjectionWrites: { at: number; stores: string[] }[] };
    return { stages: w.__gateProjectionStages, tableWrites: w.__gateProjectionWrites.filter(write => write.at >= w.__gateReadyAt) };
  });
}

test.describe("@perf city switch and viewport pan", () => {
  test.skip(!CATALOG, "PTN_SYNTHETIC_CITIES names the catalog from scripts/regression/synthetic_cities.py");
  // Each software-rendered switch can take several seconds on a CI runner.
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors.length = 0;
    expect(cities.length, "synthetic catalog needs two cities").toBe(2);
    await seedCompletedSetup(page, { cityId: cities[0].id });
    await instrument(page, errors);
    await routeSyntheticApi(page);
    await openFirstCity(page);
  });

  test("alternating city switches settle without timetable projection writes", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => (window as unknown as { __ptnMap: { jumpTo: (o: object) => void } }).__ptnMap.jumpTo({ zoom: 16 }));
    const samples: { iteration: number; cityId: string; indexOutcome: string; indexMs: number; activityMs: number;
      lastCardChangeMs: number; cards: number; heapUsedBytes: number;
      activity: { outcome: string; ready: number; requested: number } }[] = [];
    for (let iteration = 0; iteration < SWITCHES; iteration++) {
      const city = cities[(iteration + 1) % cities.length];
      await cdp.send("HeapProfiler.collectGarbage");
      // Same arrival as the diagnostic probe: jump to the city and fire the
      // terminal user moveend that pan-to-city detection listens for.
      const sample = await page.evaluate(async ({ cityId, center, timeoutMs }) => {
        type Map = { jumpTo: (o: object) => void; fire: (type: string, data: object) => void };
        const map = (window as unknown as { __ptnMap: Map }).__ptnMap;
        const start = performance.now();
        map.jumpTo({ center, zoom: 16 });
        map.fire("moveend", { originalEvent: { type: "mouseup" } });
        const pause = () => new Promise(done => setTimeout(done, 25));
        const measure = (name: string) => performance.getEntriesByName(name)
          .find(entry => entry.startTime >= start && (entry as PerformanceMeasure).detail?.cityId === cityId) as PerformanceMeasure | undefined;
        const until = async <T>(what: string, probe: () => T | undefined | false) => {
          for (;;) {
            const value = probe();
            if (value) return value;
            if (performance.now() - start > timeoutMs) throw new Error(`${cityId}: ${what} timed out`);
            await pause();
          }
        };
        const index = await until("index build", () => measure("ptn:city:index-build"));
        const activity = await until("badge activity", () => measure("ptn:city:badge-activity"));
        let fingerprint = "";
        let stableSince = performance.now();
        await until("stable stop cards", () => {
          const next = JSON.stringify([...document.querySelectorAll<HTMLElement>("[data-stop-id]")]
            .map(el => [el.dataset.stopId, el.textContent]));
          if (next !== fingerprint) { fingerprint = next; stableSince = performance.now(); }
          return performance.now() - stableSince >= 500 && document.querySelector("[data-stop-id]") !== null;
        });
        return {
          cityId,
          indexOutcome: index.detail.outcome as string,
          activity: activity.detail as { outcome: string; ready: number; requested: number },
          indexMs: index.startTime + index.duration - start,
          activityMs: activity.startTime + activity.duration - start,
          lastCardChangeMs: stableSince - start,
          cards: document.querySelectorAll("[data-stop-id]").length,
        };
      }, { cityId: city.id, center: [city.center.lon, city.center.lat], timeoutMs: STEP_TIMEOUT_MS });
      const heap = await cdp.send("Runtime.getHeapUsage");
      samples.push({ iteration, ...sample, heapUsedBytes: heap.usedSize });
    }
    const writes = await projectionWrites(page);
    const byCity = Object.fromEntries(cities.map(city => {
      const rows = samples.filter(row => row.cityId === city.id);
      return [city.id, {
        indexMs: distribution(rows.map(row => row.indexMs)),
        activityMs: distribution(rows.map(row => row.activityMs)),
        lastCardChangeMs: distribution(rows.map(row => row.lastCardChangeMs)),
      }];
    }));
    writeMetrics("city-switch", {
      workload: `${SWITCHES} alternating arrivals at zoom 16, synthetic producer-built cities`,
      percentileMethod: "nearest rank", timingGate: "recorded only (CI calibration pending)",
      cities: byCity, projectionWrites: writes, pageErrors: errors, samples,
    });
    console.log(JSON.stringify(byCity));

    for (const row of samples) {
      expect(row.indexOutcome, `${row.cityId} switch ${row.iteration}`).toBe("complete");
      expect(row.activity.outcome, `${row.cityId} switch ${row.iteration} badge activity`).toBe("complete");
      expect(row.activity.requested, `${row.cityId} switch ${row.iteration} has stops in view`).toBeGreaterThan(0);
      expect(row.activity.ready).toBe(row.activity.requested);
    }
    expect(writes, "city activation must not write legacy timetable projection tables").toEqual({ stages: [], tableWrites: [] });
    expect(errors).toEqual([]);
  });

  test("viewport pans keep labels responsive in all and urban modes", async ({ page }) => {
    const zooms = [14, 16];
    const modes: ("all" | "urban")[] = ["all", "urban"];
    const toggle = page.getByTestId("mode-toggle");
    const results = [];
    for (const mode of modes) {
      const all = mode === "all";
      if ((await toggle.getAttribute("aria-label") === "All") !== all) await toggle.click();
      // Urban mode labels the toggle "Now · <hours>"; all-stops mode says "All".
      await expect(toggle).toHaveAttribute("aria-label", all ? "All" : /^(?!All$)/);
      for (const zoom of zooms) {
        const run = await page.evaluate(async ({ zoom, timeoutMs }) => {
          type Map = { jumpTo: (o: object) => void; once: (type: string, fn: () => void) => void; panBy: (o: number[], options: object) => void;
            getLayer: (id: string) => unknown; queryRenderedFeatures: (options: object) => unknown[] };
          const map = (window as unknown as { __ptnMap: Map }).__ptnMap;
          map.jumpTo({ zoom });
          await new Promise(done => setTimeout(done, 1000));
          const start = performance.now();
          const frames: number[] = [];
          let previous: number | undefined;
          let active = true;
          const frame = (now: number) => {
            if (!active) return;
            if (previous !== undefined) frames.push(now - previous);
            previous = now;
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          // Four one-second pans around the centre, as in the investigation.
          for (const offset of [[150, 0], [0, 100], [-150, 0], [0, -100]]) {
            await Promise.race([
              new Promise<void>(done => { map.once("moveend", () => done()); map.panBy(offset, { duration: 1000, essential: true }); }),
              new Promise((_, fail) => setTimeout(() => fail(new Error(`pan at zoom ${zoom} timed out`)), timeoutMs)),
            ]);
          }
          active = false;
          const end = performance.now();
          const longTasks = (window as unknown as { __gateLongTasks: { startTime: number; duration: number }[] }).__gateLongTasks
            .filter(task => task.startTime >= start && task.startTime <= end).map(task => task.duration);
          // Stop names are map symbols below the card zoom and DOM cards from it.
          const labels = map.getLayer("stops-label") ? map.queryRenderedFeatures({ layers: ["stops-label"] }).length : 0;
          return { zoom, frames, longTasks, labels, cards: document.querySelectorAll("[data-stop-id]").length, durationMs: end - start };
        }, { zoom, timeoutMs: STEP_TIMEOUT_MS });
        results.push({ mode, zoom, frameIntervalMs: distribution(run.frames), longTaskMs: distribution(run.longTasks),
          longTaskTotalMs: run.longTasks.reduce((sum, value) => sum + value, 0), labels: run.labels, cards: run.cards, durationMs: run.durationMs });
      }
    }
    const writes = await projectionWrites(page);
    writeMetrics("viewport-pan", {
      workload: "four one-second pans per zoom/mode, first synthetic city",
      percentileMethod: "nearest rank", timingGate: "recorded only (CI calibration pending)",
      runs: results, projectionWrites: writes, pageErrors: errors,
    });
    console.log(JSON.stringify(results));

    for (const run of results) expect(run.frameIntervalMs.samples, `${run.mode} zoom ${run.zoom} rendered frames`).toBeGreaterThan(0);
    for (const run of results) {
      if (run.zoom >= ZOOM_CARDS_MIN) expect(run.cards, `${run.mode} zoom ${run.zoom} stop cards`).toBeGreaterThan(0);
      else if (run.zoom >= ZOOM_LABELS_MIN) expect(run.labels, `${run.mode} zoom ${run.zoom} stop labels`).toBeGreaterThan(0);
    }
    expect(writes).toEqual({ stages: [], tableWrites: [] });
    expect(errors).toEqual([]);
  });
});
