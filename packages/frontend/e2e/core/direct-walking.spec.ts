import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import {mockWalkGraph, WALK_FIXTURE_RELEASE as release} from "../helpers/walk-graph-fixture";
import { REF_FIXED_TIME } from "./route-overlay-refUrl";


for (const offline of [false, true]) {
test(`routed walk-only selection ${offline ? "with warm guidance after disconnect" : "online"} @mock-api`, async ({page, context}) => {
  const remotePlans: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (/\/api\/(?:[^/]+\/)?plan(?:\/|$)/.test(url.pathname)) remotePlans.push(request.url());
  });
  await context.setGeolocation({latitude: 54.68, longitude: 25.28});
  await page.clock.setFixedTime(REF_FIXED_TIME);
  await mockApi(page, {catalogNow: REF_FIXED_TIME});
  const graphRequests = await mockWalkGraph(page);
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
