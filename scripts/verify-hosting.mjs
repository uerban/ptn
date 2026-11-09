#!/usr/bin/env node
// Run against an actual installation; no PTN API responses are mocked.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {installBrowserProbe} from "./hosting-browser-probe.mjs";
import {navigate} from "./hosting-navigation.mjs";
const require = createRequire(new URL("../packages/frontend/package.json", import.meta.url));
const {chromium} = require("@playwright/test");
const [baseURL, probeFile, outputDirectory] = process.argv.slice(2);
if (!baseURL || !probeFile || !outputDirectory) throw new Error("usage: node scripts/verify-hosting.mjs <origin> <probe.json> <evidence-dir>");
const probe = JSON.parse(await readFile(probeFile, "utf8"));
const output = resolve(outputDirectory);
await mkdir(output, {recursive: true});
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({timezoneId: "Europe/Vilnius", ignoreHTTPSErrors: process.env.PTN_TEST_LOCAL_CA === "1"});
const page = await context.newPage();
const errors = [];
const serverPlans = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("request", request => {if (/\/api\/[^/]+\/plan(?:\?|$)/.test(request.url())) serverPlans.push(request.url());});
await context.route("**/*", route => {
  const url = new URL(route.request().url());
  return url.origin === new URL(baseURL).origin || ["blob:", "data:"].includes(url.protocol) ? route.continue() : route.abort();
});
await page.addInitScript(installBrowserProbe, {at: Date.parse(probe.at), fromStopId: probe.fromStopId, toStopId: probe.toStopId});
try {
  const ready = await context.request.get(`${baseURL}/api/vilnius/ready`);
  assert.equal(ready.status(), 200);
  const provenance = await ready.json();
  assert.equal(provenance.status, "ready");
  assert.equal(provenance.poiTile.ready, true, "managed POI corpus is not ready");
  const activationResponse = await context.request.get(`${baseURL}/osm/current/vilnius.json`);
  assert.equal(activationResponse.status(), 200);
  const activation = await activationResponse.json();
  const osmManifest = await context.request.get(`${baseURL}/osm/releases/${activation.release}/manifest.json`);
  assert.equal(osmManifest.status(), 200);
  assert.equal(createHash("sha256").update(await osmManifest.body()).digest("hex"), activation.release);
  const graph = await context.request.get(`${baseURL}/osm/releases/${activation.release}/walk-graph.ptwg.br`);
  assert.equal(graph.status(), 200);
  assert.equal(graph.headers()["content-encoding"], undefined, "walk graph must remain opaque bytes");
  const graphManifest = (await osmManifest.json()).components.walkGraph;
  assert.equal(createHash("sha256").update(await graph.body()).digest("hex"), graphManifest.sha256);
  assert.equal((await context.request.get(`${baseURL}/poi/manifest.json`)).status(), 200);
  assert.equal((await context.request.get(`${baseURL}/api/vilnius/address-search/manifest`)).status(), 200);
  const bundle = await context.request.get(`${baseURL}/api/vilnius/raptor-bundle`);
  assert.equal(bundle.status(), 200);
  const transferURL = bundle.headers()["x-pt-transfers-artifact-url"];
  assert(transferURL, "walking transfer artifact is absent");
  const transfers = await context.request.get(new URL(transferURL, baseURL).href);
  assert.equal(transfers.status(), 200);
  assert.equal(createHash("sha256").update(await transfers.body()).digest("hex"), bundle.headers()["x-pt-transfers-artifact-hash"]);
  for (const path of ["/api/not-a-city/ready", "/api/vilnius/not-a-route", "/api/vilnius/metrics", "/api/vilnius/scheduled-departures-for-stop", "/assets/missing.wasm", "/osm/private/key.pem"]) {
    assert.equal((await context.request.get(`${baseURL}${path}`)).status(), 404, path);
  }
  const params = new URLSearchParams({fromStopId: probe.fromStopId, toStopId: probe.toStopId});
  await navigate(page, `${baseURL}/search?${params}`);
  // A fresh install opens onboarding: either a city picker, or (when the
  // city is preselected) the plan-mode/privacy step. Accept both.
  const chooseCity = page.getByRole("button", {name: /^Vilnius/}).first();
  const recommended = page.getByRole("button", {name: "Start with recommended settings"});
  await chooseCity.or(recommended).first().waitFor({timeout: 30_000});
  if (await chooseCity.isVisible()) await chooseCity.click();
  await recommended.waitFor({timeout: 30_000}).catch(() => {});
  if (await recommended.isVisible()) await recommended.click();
  await page.locator("[data-testid='itinerary-card']").first().waitFor({timeout: 120_000});
  await page.waitForFunction(() => globalThis.__PTN_HOST_CHECK__.transitResults > 0);
  assert(page.workers().some(worker => /ptRouter\.worker/.test(worker.url())), "no on-device router worker");
  assert.deepEqual(serverPlans, [], "browser sent a route query to the server");
  // City activation keeps decoded stops in memory; the legacy gtfsStops
  // projection is intentionally empty on a fresh installation.
  const {catalogStops, journeyStopsPresent} = await page.evaluate(() => globalThis.__PTN_HOST_CHECK__);
  assert(catalogStops > 0, "browser did not decode the city catalog");
  assert(journeyStopsPresent, "decoded catalog is missing the journey stops");
  assert.deepEqual(errors, [], "uncaught browser errors");
  await page.screenshot({path: resolve(output, "route.png"), fullPage: true});
  const transitResults = await page.evaluate(() => globalThis.__PTN_HOST_CHECK__.transitResults);
  await writeFile(resolve(output, "result.json"), JSON.stringify({baseURL, generation: provenance.servingGenerationId, catalogStops, journeyStopsPresent, routerWorker: true, transitResults, serverPlanRequests: serverPlans.length}, null, 2) + "\n");
  console.log(`PASS: ${catalogStops} catalog stops, on-device route, zero server plan requests`);
} catch (error) {
  await page.screenshot({path: resolve(output, "failure.png"), fullPage: true});
  await writeFile(resolve(output, "failure.html"), await page.content());
  throw error;
} finally {await browser.close();}
