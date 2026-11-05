import { describe, it, expect } from "vitest";
import { GtfsStore } from "../../src/gtfs/store.ts";
import { buildIndexes } from "../../src/gtfs/index-builder.ts";
import {
  fixtureStops,
  fixtureRoutes,
  fixtureTrips,
  fixtureStopTimes,
  fixtureServices,
} from "../../src/gtfs/__fixtures__/simpleCity.ts";

function buildFixture() {
  return buildIndexes(
    fixtureStops,
    fixtureRoutes,
    fixtureTrips,
    fixtureStopTimes,
    fixtureServices,
    [],
  );
}

describe("GtfsStore.generation", () => {
  it("starts at 0", () => {
    const store = new GtfsStore();
    expect(store.getGeneration()).toBe(0);
  });

  it("increments by 1 on each swap", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixture();

    store.swap(indexes, canonical, routingInput);
    expect(store.getGeneration()).toBe(1);
    store.swap(indexes, canonical, routingInput);
    expect(store.getGeneration()).toBe(2);
    store.swap(indexes, canonical, routingInput);
    expect(store.getGeneration()).toBe(3);
  });
});
