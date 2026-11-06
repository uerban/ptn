import assert from "node:assert/strict";
import {chromium} from "../packages/frontend/node_modules/@playwright/test/index.mjs";
const base = process.argv[2] ?? "http://127.0.0.1:4178";
const browser = await chromium.launch({headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
const context = await browser.newContext({viewport: {width: 1000, height: 740}});
const city = {id: "custom", name: "Custom City", tz: "UTC", center: {lat: 10, lon: 10}, bbox: {minLat: 9, minLon: 9, maxLat: 11, maxLon: 11}};
let transitRequests = 0;
await context.route("**/deployment-config.js", route => route.fulfill({contentType: "application/javascript", body: 'globalThis.__PTN_DEPLOYMENT__={cities:"all"};'}));
await context.route("**/api/**", route => {
  if (new URL(route.request().url()).pathname === "/api/cities") return route.fulfill({json: {schemaVersion: 2, cities: [city]}});
  transitRequests++;
  return route.fulfill({status: 503, body: "test backend"});
});
await context.addInitScript(() => {
  window.gpsRequests = 0;
  navigator.geolocation.getCurrentPosition = () => {window.gpsRequests++;};
});
try {
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole("heading", {name: "Choose a city"}).waitFor();
  assert.equal(await page.evaluate(() => window.gpsRequests), 0);
  assert.equal(transitRequests, 0, "transit data fetched before city choice");
  await page.getByRole("button", {name: "Custom City", exact: true}).first().waitFor();
  await page.locator('[data-city-map-ready="true"]').waitFor();
  await page.screenshot({path: "/tmp/ptn-city-selector.png"});
  await page.getByRole("button", {name: "Use my location"}).click();
  assert.equal(await page.evaluate(() => window.gpsRequests), 1);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", {name: "Custom City · Connect to download", exact: true}).waitFor();
  assert.equal(await page.getByRole("button", {name: "Custom City · Connect to download", exact: true}).isDisabled(), true);
  await context.setOffline(false);
  await page.reload();
  await page.getByRole("button", {name: "Custom City", exact: true}).first().waitFor();
  const selectedRequest = page.waitForRequest(request => new URL(request.url()).pathname.startsWith("/api/custom/"));
  await page.getByRole("button", {name: "Custom City", exact: true}).first().click();
  await selectedRequest;
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ptn-city")).state.activeCity.id), "custom");
  const restoredRequest = page.waitForRequest(request => new URL(request.url()).pathname.startsWith("/api/custom/"));
  await page.reload();
  await restoredRequest;
  console.log("PASS: unknown city discovery, no default fetch/GPS, offline metadata is not a download");
} finally {await context.close(); await browser.close();}
