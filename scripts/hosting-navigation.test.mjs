import assert from "node:assert/strict";
import {test} from "node:test";
import {navigate} from "./hosting-navigation.mjs";

test("retries transient network changes and returns the navigation response", async () => {
  let calls = 0;
  const response = {};
  const page = {async goto(url) {
    assert.equal(url, "https://localhost/search");
    if (++calls < 3) throw new Error("page.goto: net::ERR_NETWORK_CHANGED");
    return response;
  }};
  assert.equal(await navigate(page, "https://localhost/search"), response);
  assert.equal(calls, 3);
});

test("persistent network changes fail after three attempts", async () => {
  let calls = 0;
  const error = new Error("page.goto: net::ERR_NETWORK_CHANGED");
  await assert.rejects(navigate({async goto() {calls++; throw error;}}, "https://localhost"), value => value === error);
  assert.equal(calls, 3);
});

test("other navigation failures are not retried", async () => {
  for (const message of ["net::ERR_CONNECTION_REFUSED", "net::ERR_CERT_AUTHORITY_INVALID", "Timeout 30000ms exceeded"]) {
    let calls = 0;
    const error = new Error(message);
    await assert.rejects(navigate({async goto() {calls++; throw error;}}, "https://localhost"), value => value === error);
    assert.equal(calls, 1);
  }
});

// Exercise the same init script installed in the fresh-host browser, with
// worker messages rather than application data or legacy IndexedDB rows.
test("browser probe observes decoded journey stops and transit worker results", async () => {
  const {installBrowserProbe} = await import("./hosting-browser-probe.mjs");
  const {runInNewContext} = await import("node:vm");
  class Worker extends EventTarget {}
  const scope = {Worker};
  runInNewContext(`(${installBrowserProbe.toString()})(${JSON.stringify({
    at: 1234, fromStopId: "origin", toStopId: "destination",
  })})`, scope);
  const catalog = new scope.Worker("/assets/ptbCatalog.worker-hash.js");
  const reply = (worker, data) => worker.dispatchEvent(new MessageEvent("message", {data}));
  reply(catalog, {ok: false});
  assert.equal(scope.__PTN_HOST_CHECK__.catalogStops, 0);
  reply(catalog, {ok: true, data: {meta: {cityId: "other-city"}, stops: [{id: "origin"}]}});
  assert.equal(scope.__PTN_HOST_CHECK__.catalogStops, 0);
  reply(catalog, {ok: true, data: {meta: {cityId: "vilnius"}, stops: [{id: "origin"}]}});
  assert.equal(scope.__PTN_HOST_CHECK__.catalogStops, 1);
  assert.equal(scope.__PTN_HOST_CHECK__.journeyStopsPresent, false);
  reply(catalog, {ok: true, data: {meta: {cityId: "vilnius"}, stops: [{id: "origin"}, {id: "destination"}]}});
  assert.equal(scope.__PTN_HOST_CHECK__.catalogStops, 2);
  assert.equal(scope.__PTN_HOST_CHECK__.journeyStopsPresent, true);
  const router = new scope.Worker("/assets/ptRouter.worker-hash.js");
  reply(router, {ok: true, value: [{legs: [{tripId: "trip"}]}, {legs: []}]});
  assert.equal(scope.__PTN_HOST_CHECK__.transitResults, 1);
  assert.equal(runInNewContext("Date.now()", scope), 1234);
});
