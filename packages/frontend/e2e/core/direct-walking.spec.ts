import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { mockApi } from "../helpers/mock-api";
import { REF_FIXED_TIME } from "./route-overlay-refUrl";

// Actual compiled pedestrian graph, not an injected route response. Regenerate:
// cargo run -p pt-walk --features build --bin pt-walk-build -- --input
// crates/pt-walk/tests/fixtures/tiny.geojsonseq --city vilnius
// --generated-at 2026-10-26 --out packages/frontend/e2e/fixtures/tiny-walk.ptwg
const graph = readFileSync(new URL("../fixtures/tiny-walk.ptwg", import.meta.url));
const compressed = brotliCompressSync(graph);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifest = Buffer.from(JSON.stringify({schemaVersion: 1, city: "vilnius", components: {
  walkGraph: {status: "present", format: "ptwg", formatVersion: 2, compression: "brotli",
    sha256: hash(compressed), bytes: compressed.length, decodedBytes: graph.length},
}}));
const release = hash(manifest);

for (const offline of [false, true]) {
test(`routed walk-only selection ${offline ? "with warm guidance after disconnect" : "online"} @mock-api`, async ({page, context}) => {
  const remotePlans: string[] = [];
  const graphRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (/\/api\/(?:[^/]+\/)?plan(?:\/|$)/.test(url.pathname)) remotePlans.push(request.url());
  });
  await context.setGeolocation({latitude: 54.68, longitude: 25.28});
  await page.clock.setFixedTime(REF_FIXED_TIME);
  await mockApi(page, {catalogNow: REF_FIXED_TIME});
  await page.route("**/osm/**", async route => {
    const url = new URL(route.request().url());
    graphRequests.push(url.pathname);
    expect(url.search).toBe("");
    expect(route.request().method()).toBe("GET");
    expect(route.request().postData()).toBeNull();
    const path = url.pathname;
    if (path === "/osm/current/vilnius.json") {
      await route.fulfill({json: {schemaVersion: 1, release, revision: 1}});
    } else if (path === `/osm/releases/${release}/manifest.json`) {
      await route.fulfill({body: manifest, contentType: "application/json"});
    } else if (path === `/osm/releases/${release}/walk-graph.ptwg.br`) {
      await route.fulfill({body: compressed, contentType: "application/octet-stream"});
    } else await route.fulfill({status: 404});
  });
  await page.goto("/search?toLat=54.68&toLon=25.281&toName=Pedestrian%20fixture");
  const card = page.getByTestId("itinerary-card").first();
  await expect(card).toBeVisible({timeout: 15_000});
  // The fixture's 0.001 longitude segment at 54.68 latitude is 64 m.
  await expect(card).toContainText(/64/);
  expect(graphRequests).toContain(`/osm/releases/${release}/walk-graph.ptwg.br`);
  if (offline) {
    // Warm the lazy guidance page. Cold offline installation requires the
    // production service-worker harness, not Vite's on-demand modules.
    await card.click();
    await expect(page.getByTestId("leg-row")).toHaveCount(1);
    await page.goBack();
    await expect(card).toBeVisible();
    // Route mocks can fulfill requests even with context offline. Abort every
    // subsequent request too, so fixtures cannot mask a network dependency.
    await page.route("**/*", route => route.abort("internetdisconnected"));
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  }
  await card.click();
  await expect(page.getByTestId("leg-row")).toHaveCount(1);
  await page.waitForFunction(() => {
    const map = (window as unknown as {__ptnMap?: {getSource(id: string): unknown}}).__ptnMap;
    return !!map?.getSource("guidance-leg-0");
  });
  expect(await page.evaluate(() => {
    const map = (window as unknown as {__ptnMap?: {getSource(id: string): unknown}}).__ptnMap;
    return !!map?.getSource("guidance-leg-1");
  })).toBe(false);
  expect(remotePlans).toEqual([]);
});
}
