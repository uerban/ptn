import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoutingBundleData } from "@pt/shared";
import { db, type GtfsSyncMeta } from "../db/index.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { activateCityData, captureCityData, CityDataContext, invalidateCityData, updateCityShapes } from "./cityData.ts";

const initialCity = useCityStore.getState().activeCity;
function context(cityId: string, generationId: string, name: string): CityDataContext {
  const wire: RoutingBundleData = {
    meta: {cityId, generatedAt: "2026-11-07", cityTzIana: "UTC"},
    stops: [{id: "same-stop", name, lat: 1, lon: 2}],
    routes: [{id: "same-route", shortName: name, mode: "BUS", stopIds: ["same-stop"],
      trips: [{tripId: "same-trip", serviceId: "service", headsign: name, departureSecs: [100], shapeId: "same-shape"}]}],
    calendar: [],
  };
  return new CityDataContext(wire, {id: "current", cityId, generationId, etag: generationId, generatedAt: "2026-11-07", lastSynced: 1},
    [{shapeId: "same-shape", source: "gtfs", encodedPolyline: name}]);
}
function select(cityId: string) { useCityStore.setState({activeCity: {...initialCity, id: cityId}}); }
const meta: GtfsSyncMeta = {id: "current", cityId: "vilnius", generationId: "legacy-a", etag: "etag-a", generatedAt: "2026-11-07", lastSynced: 1};
beforeEach(async () => {
  invalidateCityData();
  select("vilnius");
  await db.delete();
  await db.open();
});
afterEach(() => { invalidateCityData(); useCityStore.setState({activeCity: initialCity}); });

describe("captured city data", () => {
  it("reads one decoded generation without consulting foreign shared-table rows", async () => {
    await db.gtfsStops.put({id: "same-stop", name: "foreign disk row", lat: 3, lon: 4});
    activateCityData(context("vilnius", "a", "A"));
    const data = captureCityData();
    expect((await data.gtfsStops.get("same-stop"))?.name).toBe("A");
    expect((await data.gtfsTrips.get("same-trip"))?.headsign).toBe("A");
    expect((await data.gtfsShapes.get("same-shape"))?.encodedPolyline).toBe("A");
    expect((await data.stopGroups.toArray())[0]?.name).toBe("A");
    expect(data.token).toMatchObject({cityId: "vilnius", generationId: "a"});
  });

  it("rejects old views after city switches and A→B→A, even when IDs are identical", async () => {
    const a = context("vilnius", "a", "A");
    activateCityData(a);
    const old = captureCityData();
    select("krakow");
    activateCityData(context("krakow", "b", "B"));
    await expect(old.gtfsTrips.get("same-trip")).rejects.toMatchObject({name: "AbortError"});
    select("vilnius");
    activateCityData(context("vilnius", "a", "A again"));
    await expect(old.gtfsStops.toArray()).rejects.toMatchObject({name: "AbortError"});
    expect((await captureCityData().gtfsStops.get("same-stop"))?.name).toBe("A again");
  });

  it("rejects a same-city generation replacement between stop and trip reads", async () => {
    activateCityData(context("vilnius", "a", "A"));
    const old = captureCityData();
    await old.gtfsStops.toArray();
    activateCityData(context("vilnius", "b", "B"));
    await expect(old.gtfsTrips.toArray()).rejects.toMatchObject({name: "AbortError"});
  });

  it("accepts shape completion only for its owning generation and rebuilds its lookup", async () => {
    const a = context("vilnius", "a", "A");
    activateCityData(a);
    const data = captureCityData();
    await data.gtfsShapes.get("same-shape");
    expect(updateCityShapes(a, [{shapeId: "same-shape", encodedPolyline: "updated", source: "gtfs"}])).toBe(true);
    expect((await data.gtfsShapes.get("same-shape"))?.encodedPolyline).toBe("updated");
    activateCityData(context("vilnius", "b", "B"));
    expect(updateCityShapes(a, [])).toBe(false);
  });

  it("reads a legacy projection only under matching city metadata", async () => {
    await db.gtfsStops.put({id: "same-stop", name: "A", lat: 1, lon: 2});
    expect(await captureCityData().gtfsStops.toArray()).toEqual([]);
    await db.gtfsSyncMeta.put({...meta, cityId: "krakow"});
    expect(await captureCityData().gtfsStops.toArray()).toEqual([]);
    await db.gtfsSyncMeta.put(meta);
    expect((await captureCityData().gtfsStops.get("same-stop"))?.name).toBe("A");
  });

  it("rejects mixed generations in multi-step legacy reads", async () => {
    await db.gtfsSyncMeta.put(meta);
    await db.gtfsStops.put({id: "same-stop", name: "A", lat: 1, lon: 2});
    const data = captureCityData();
    await data.gtfsStops.toArray();
    await db.gtfsSyncMeta.put({...meta, generationId: "legacy-b"});
    await expect(data.gtfsTrips.toArray()).rejects.toMatchObject({name: "AbortError"});
  });
});
