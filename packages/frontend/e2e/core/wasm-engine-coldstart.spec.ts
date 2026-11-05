// pt-wasm cold-start budget e2e (panel perf #3, engineer #3).
//
// Measures the four-component cold-start latency partition emitted by
// `services/raptorWasm.ts` (`ptn:wasm:{import,instantiate,ptnew,firstplan}`
// performance.mark pairs), then asserts the p95 over N cold contexts
// stays under per-component AND aggregate budgets.
//
// Two profiles:
//   - "fast"      — unthrottled. Tighter budgets. N=11 (drop the warm-up
//                   sample), runs under the `pr-chromium` project.
//   - "throttled" — real CPU throttle via CDP `Emulation.setCPUThrottlingRate`
//                   (panel perf #3 — `--js-flags=--predictable` does NOT
//                   throttle, only makes V8 deterministic). 2× budgets,
//                   smaller N=6 to keep CI wall-time bounded. Runs under
//                   the `pr-chromium-throttled` project (grep matches
//                   `@coldstart` — both tests in this file carry the tag).
//
// Engineer #3 caveat baked in: measurement is driven through real app
// navigation (`page.goto("/search?...")`), never by
// hardcoding a dist asset URL — that path bypasses Vite's hashed-bundle
// resolution and would silently rot when the hash changes.
import { test, expect } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";

const BUDGETS_MS_FAST = {
  dynImport: 300,
  instantiate: 400,
  ptNew: 500,
  plan: 300,
  total: 1500,
};

const BUDGETS_MS_THROTTLED = {
  dynImport: 600,
  instantiate: 800,
  ptNew: 1000,
  plan: 600,
  total: 3000,
};

interface ColdSample {
  dynImport: number;
  instantiate: number;
  ptNew: number;
  plan: number;
  total: number;
}

async function measureCold(
  page: import("@playwright/test").Page,
  throttled: boolean,
): Promise<ColdSample> {
  if (throttled) {
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  // Drive measurement THROUGH the app — `services/raptorWasm.ts` emits
  // `performance.mark` pairs around dyn-import / instantiate / ptNew
  // during `buildPtRouter()`, and around the first `plan()` call inside
  // `planWithWasm()`. The spec doesn't need to know the call sites; it
  // reads the mark timestamps once an
  // itinerary has rendered (which proves the whole chain ran). Stop-id
  // query pair triggers Search.tsx's auto-search effect (no endpoints =
  // no plan call = no marks fired). The matched fixture time is shortly before
  // its active S1 → S3 trip.
  await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
  await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
  await page
    .locator("[data-testid='itinerary-card']")
    .first()
    .waitFor({ timeout: 20_000 });
  return await page.evaluate((): ColdSample => {
    // Read the most recent marks directly; every cold context has one sample,
    // and subtracting timestamps avoids adding derived entries to the timeline.
    const markTime = (name: string): number => {
      const entries = performance.getEntriesByName(name, "mark");
      const entry = entries[entries.length - 1];
      if (!entry) throw new Error(`Missing performance mark: ${name}`);
      return entry.startTime;
    };
    const measure = (start: string, end: string): number =>
      markTime(end) - markTime(start);
    return {
      dynImport: measure("ptn:wasm:import:start", "ptn:wasm:import:end"),
      instantiate: measure(
        "ptn:wasm:instantiate:start",
        "ptn:wasm:instantiate:end",
      ),
      ptNew: measure("ptn:wasm:ptnew:start", "ptn:wasm:ptnew:end"),
      plan: measure("ptn:wasm:firstplan:start", "ptn:wasm:firstplan:end"),
      total: measure("ptn:wasm:import:start", "ptn:wasm:firstplan:end"),
    };
  });
}

const p95 = (xs: number[]): number =>
  xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

test.describe("wasm engine cold-start @coldstart @mock-api", () => {
  test("first plan() respects 4-component split budget (p95 over N=10, fast profile)", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "pr-chromium",
      "Fast budget is calibrated for pr-chromium",
    );
    const samples: ColdSample[] = [];
    for (let i = 0; i < 11; i++) {
      const ctx = await page.context().browser()!.newContext();
      const p = await ctx.newPage();
      await mockApi(p, { routingFixture: "ptb-matched" });
      samples.push(await measureCold(p, false));
      await ctx.close();
    }
    samples.shift(); // discard warm-up sample (CDN/proxy cold caches)

    expect(p95(samples.map((s) => s.dynImport))).toBeLessThan(
      BUDGETS_MS_FAST.dynImport,
    );
    expect(p95(samples.map((s) => s.instantiate))).toBeLessThan(
      BUDGETS_MS_FAST.instantiate,
    );
    expect(p95(samples.map((s) => s.ptNew))).toBeLessThan(
      BUDGETS_MS_FAST.ptNew,
    );
    expect(p95(samples.map((s) => s.plan))).toBeLessThan(BUDGETS_MS_FAST.plan);
    expect(p95(samples.map((s) => s.total))).toBeLessThan(
      BUDGETS_MS_FAST.total,
    );
  });

  test("respects 2× budgets under real CDP CPU throttle (panel perf #3)", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "pr-chromium-throttled",
      "Throttled budget requires the dedicated Chromium project",
    );
    const samples: ColdSample[] = [];
    for (let i = 0; i < 6; i++) {
      // smaller N under throttle to keep test wall-time bounded
      const ctx = await page.context().browser()!.newContext();
      const p = await ctx.newPage();
      await mockApi(p, { routingFixture: "ptb-matched" });
      samples.push(await measureCold(p, true));
      await ctx.close();
    }
    samples.shift();
    expect(p95(samples.map((s) => s.total))).toBeLessThan(
      BUDGETS_MS_THROTTLED.total,
    );
  });
});
