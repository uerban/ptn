#!/usr/bin/env node
// Run against an actual installation; no PTN API responses are mocked.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
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
await page.addInitScript(({at}) => {
  globalThis.__PTN_HOST_CHECK__ = {transitResults: 0};
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (/ptRouter\.worker/.test(String(url))) {
        this.addEventListener("message", ({data}) => {
          if (data?.ok && Array.isArray(data.value)) {
            globalThis.__PTN_HOST_CHECK__.transitResults += data.value.filter(itinerary =>
              itinerary.legs?.some(leg => typeof leg.tripId === "string" && leg.tripId.length > 0)).length;
          }
        });
      }
    }
  };
  const NativeDate = Date;
  function FixedDate(...args) {
    if (!new.target) return new NativeDate(at).toString();
    return Reflect.construct(NativeDate, args.length ? args : [at], new.target);
  }
  Object.setPrototypeOf(FixedDate, NativeDate);
  FixedDate.prototype = NativeDate.prototype;
  FixedDate.now = () => at;
  globalThis.Date = FixedDate;
}, {at: Date.parse(probe.at)});
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
  await page.locator("[data-testid='itinerary-card']").first().waitFor({timeout: 120_000});
  await page.waitForFunction(() => globalThis.__PTN_HOST_CHECK__.transitResults > 0);
  assert(page.workers().some(worker => /ptRouter\.worker/.test(worker.url())), "no on-device router worker");
  assert.deepEqual(serverPlans, [], "browser sent a route query to the server");
  const storedStops = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ptn");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("gtfsStops").objectStore("gtfsStops").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {database.close();}
  });
  assert(storedStops > 0, "browser did not synchronize stops");
  assert.deepEqual(errors, [], "uncaught browser errors");
  await page.screenshot({path: resolve(output, "route.png"), fullPage: true});
  const transitResults = await page.evaluate(() => globalThis.__PTN_HOST_CHECK__.transitResults);
  await writeFile(resolve(output, "result.json"), JSON.stringify({baseURL, generation: provenance.servingGenerationId, storedStops, routerWorker: true, transitResults, serverPlanRequests: serverPlans.length}, null, 2) + "\n");
  console.log(`PASS: ${storedStops} stops, on-device route, zero server plan requests`);
} catch (error) {
  await page.screenshot({path: resolve(output, "failure.png"), fullPage: true});
  await writeFile(resolve(output, "failure.html"), await page.content());
  throw error;
} finally {await browser.close();}
