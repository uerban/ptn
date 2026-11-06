import {beforeEach, expect, it} from "vitest";
import {db} from "../db/index.ts";
import {saveDeviceCity, restoreDeviceCity, removeDeviceCity, listDeviceCities, hasLiveDeviceCity} from "./deviceCities.ts";
import type {CityConfig} from "../config/cities.ts";
const city: CityConfig = {id: "custom", name: "Custom", tz: "UTC", available: true, center: {lat: 1, lon: 1}, bbox: {minLat: 0, minLon: 0, maxLat: 2, maxLon: 2}};
beforeEach(async () => {await db.open(); await Promise.all(db.tables.map(table => table.clear()));});
async function seed(id: string) {
  await db.table("gtfsSyncMeta").put({id: "current", cityId: id, lastSynced: Date.now()});
  await db.table("ptbBytes").put({cityId: id, bytes: new Uint8Array([1, 2]), etag: id});
  await db.table("gtfsBundle").put({cityId: id, compressedBytes: new ArrayBuffer(2), compressedSize: 2});
  await db.gtfsStops.clear(); await db.table("gtfsStops").put({id: `stop-${id}`, name: id});
}
it("retains explicit downloads across live-cache eviction and restores the selected city", async () => {
  await seed(city.id); await saveDeviceCity(city);
  await seed("second"); await saveDeviceCity({...city, id: "second"});
  await db.gtfsBundle.clear(); await db.ptbBytes.clear(); await db.gtfsStops.clear();
  expect(await listDeviceCities()).toHaveLength(2);
  expect(await restoreDeviceCity(city.id)).toBe(true);
  expect((await db.gtfsSyncMeta.get("current"))?.cityId).toBe(city.id);
  expect((await db.gtfsStops.toArray()).map(stop => stop.id)).toEqual(["stop-custom"]);
  await removeDeviceCity(city.id);
  expect((await listDeviceCities()).map(c => c.cityId)).toEqual(["second"]);
});
it("does not treat catalog metadata as a downloaded city", async () => {
  await expect(saveDeviceCity(city)).rejects.toThrow();
  expect(await listDeviceCities()).toHaveLength(0);
});
it("requires declared walking transfers before saving", async () => {
  await seed(city.id);
  await db.ptbBytes.put({...(await db.ptbBytes.get(city.id))!, transfersArtifact: {url: "/transfer", hash: "missing", sizeBytes: 1}});
  await expect(saveDeviceCity(city)).rejects.toThrow("Walking transfers");
});
it("does not restore after a city switch aborts its generation", async () => {
  await seed(city.id); await saveDeviceCity(city); await seed("second");
  const controller = new AbortController(); controller.abort();
  await expect(restoreDeviceCity(city.id, controller.signal)).rejects.toThrow();
  expect((await db.gtfsSyncMeta.get("current"))?.cityId).toBe("second");
});

it("distinguishes a usable current cache from catalog metadata and retained downloads", async () => {
  expect(await hasLiveDeviceCity(city.id)).toBe(false);
  await seed(city.id);
  expect(await hasLiveDeviceCity(city.id)).toBe(true);
  expect(await listDeviceCities()).toHaveLength(0);
  expect(await hasLiveDeviceCity("other")).toBe(false);
});

it("keeps transfer bytes referenced by a live city when another download is removed", async () => {
  await seed(city.id); await saveDeviceCity(city);
  await seed("live");
  await db.ptbBytes.put({...(await db.ptbBytes.get("live"))!, transfersArtifact: {url: "/transfer", hash: "live-hash", sizeBytes: 1}});
  await db.offlineTransfers.bulkPut([{hash: "live-hash", bytes: new Uint8Array([1])}, {hash: "unused", bytes: new Uint8Array([2])}]);
  await removeDeviceCity(city.id);
  expect(await hasLiveDeviceCity("live")).toBe(true);
  expect(await db.offlineTransfers.get("unused")).toBeUndefined();
});

it("serializes restore against removal so a live package keeps its transfers", async () => {
  await seed(city.id);
  await db.ptbBytes.put({...(await db.ptbBytes.get(city.id))!, transfersArtifact: {url: "/transfer", hash: "shared", sizeBytes: 1}});
  await db.offlineTransfers.put({hash: "shared", bytes: new Uint8Array([1])});
  await saveDeviceCity(city);
  await db.ptbBytes.clear(); await db.gtfsBundle.clear();
  const [restored] = await Promise.all([restoreDeviceCity(city.id), removeDeviceCity(city.id)]);
  expect(restored).toBe(true);
  expect(await hasLiveDeviceCity(city.id)).toBe(true);
  expect(await listDeviceCities()).toHaveLength(0);
});
