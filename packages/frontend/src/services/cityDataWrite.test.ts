import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { cityDataWrite } from "./cityDataWrite.ts";

beforeEach(async () => { await db.gtfsStops.clear(); });

it("rolls back completed requests when an activation is aborted inside its transaction", async () => {
  await db.gtfsStops.put({id: "previous", name: "Previous", lat: 1, lon: 2});
  const controller = new AbortController();
  await expect(cityDataWrite([db.gtfsStops], controller.signal, async () => {
    await db.gtfsStops.clear();
    await db.gtfsStops.put({id: "obsolete", name: "Obsolete", lat: 3, lon: 4});
    controller.abort();
  })).rejects.toThrow();
  expect((await db.gtfsStops.toArray()).map(stop => stop.id)).toEqual(["previous"]);
  await cityDataWrite([db.gtfsStops], undefined, async () => {
    await db.gtfsStops.clear();
    await db.gtfsStops.put({id: "new-city", name: "New city", lat: 5, lon: 6});
  });
  expect((await db.gtfsStops.toArray()).map(stop => stop.id)).toEqual(["new-city"]);
});

it("never opens a write body for an already superseded activation", async () => {
  const controller = new AbortController();
  controller.abort();
  let entered = false;
  await expect(cityDataWrite([db.gtfsStops], controller.signal, async () => { entered = true; })).rejects.toThrow();
  expect(entered).toBe(false);
});
