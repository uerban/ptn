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
