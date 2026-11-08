import {expect, test} from "@playwright/test";
import {mockApi} from "../helpers/mock-api";
import {setFixedDate} from "../helpers/fixed-date";
import {FIXTURE_BUNDLE_HASH} from "../helpers/schedule-tile-fixture";

// Actual tile loading, hook publication and MapLibre marker DOM. The second
// round deliberately evicts the tile while retaining a still-valid verdict.
test("urban cards start name-only and retain resolved badges during a slow refresh @mock-api", async ({page}) => {
  const vite = await page.request.get("/@vite/client");
  test.skip(!vite.ok() || !(await vite.text()).includes("vite"), "Requires the development map/store harness");
  const serviceTime = new Date("2026-05-05T12:00:00+03:00");
  await setFixedDate(page, serviceTime);
  await mockApi(page, {catalogShapes: "absent", catalogNow: serviceTime});
  await page.addInitScript(() => {
    (window as any).__tileDecodeCount = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.name === "ptn:city:tile-decode") (window as any).__tileDecodeCount++;
    }).observe({entryTypes: ["measure"]});
  });
  let release!: () => void;
  let gate = new Promise<void>(resolve => {release = resolve;});
  let requests = 0;
  await page.route("**/gtfs/schedule-tile/**", async route => {
    requests++;
    await gate;
    await route.fallback();
  });
  try {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as any).__ptnMap);
    await page.evaluate(() => (window as any).__ptnMap.jumpTo({center: [25.2797, 54.6872], zoom: 20}));
    const card = page.locator('[data-stop-id="s1"]');
    await expect(card.locator(".cursor-pointer")).toBeVisible();
    await expect(card).toContainText("Gedimino pr.");
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(card.locator("span")).toHaveCount(0);
    release();
    await expect(card.locator("span")).toHaveText(["1", "2"]);

    await expect.poll(() => page.evaluate(async () => {
      const path = "/src/db/index.ts";
      const {db} = await import(path);
      return db.scheduleTileCache.count();
    })).toBeGreaterThan(0);
    const firstRequests = requests;
    gate = new Promise<void>(resolve => {release = resolve;});
    await page.evaluate(async hash => {
      const cachePath = "/src/services/scheduleTileCache.ts";
      const badgePath = "/src/stores/badgeActivityStore.ts";
      const {pruneToBundleHash} = await import(cachePath);
      const {useBadgeActivityStore} = await import(badgePath);
      const probe = (window as any).__badgeContinuity = {counts: [2], publications: 0};
      const observer = new MutationObserver(() => {
        probe.counts.push(document.querySelectorAll('[data-stop-id="s1"] span').length);
      });
      observer.observe(document.body, {subtree: true, childList: true, characterData: true});
      const unsubscribe = useBadgeActivityStore.subscribe((state: any, previous: any) => {
        const next = state.byStop.get("s1");
        if (next !== previous.byStop.get("s1") && next?.state === "ready") probe.publications++;
      });
      probe.dispose = () => {observer.disconnect(); unsubscribe();};
      await pruneToBundleHash("0".repeat(64), hash);
      // Expand from a single-stop view to restart the real viewport sweep.
      (window as any).__ptnMap.jumpTo({center: [25.2797, 54.6872], zoom: 17});
    }, FIXTURE_BUNDLE_HASH);
    await expect.poll(() => requests).toBeGreaterThan(firstRequests);
    await expect(card.locator("span")).toHaveText(["1", "2"]);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).__badgeContinuity.counts.every((count: number) => count === 2))).toBe(true);
    release();
    await expect.poll(() => page.evaluate(() => (window as any).__badgeContinuity.publications)).toBeGreaterThan(0);
    await expect(card.locator("span")).toHaveText(["1", "2"]);
    expect(await page.evaluate(() => (window as any).__badgeContinuity.counts.every((count: number) => count === 2))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__tileDecodeCount)).toBeGreaterThan(0);
    const settled = await page.evaluate(() => ({
      decodes: (window as any).__tileDecodeCount,
      publications: (window as any).__badgeContinuity.publications,
    }));
    const settledRequests = requests;
    // Both warm viewport sweeps use the same already decoded tile.
    for (const [index, zoom] of [20, 17].entries()) {
      await page.evaluate(zoom => (window as any).__ptnMap.jumpTo({zoom}), zoom);
      await expect.poll(() => page.evaluate(() => (window as any).__badgeContinuity.publications))
        .toBeGreaterThan(settled.publications + index);
    }
    expect(requests).toBe(settledRequests);
    expect(await page.evaluate(() => (window as any).__tileDecodeCount)).toBe(settled.decodes);
    expect(settled.decodes).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__badgeContinuity.counts.every((count: number) => count === 2))).toBe(true);
    await page.evaluate(() => (window as any).__badgeContinuity.dispose());
  } finally { release(); }
});
