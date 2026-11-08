import {beforeEach, expect, it, vi} from "vitest";
import {db} from "../db/index.ts";
import {saveDeviceCity, restoreDeviceCity, removeDeviceCity, listDeviceCities, hasLiveDeviceCity} from "./deviceCities.ts";
import type {CityConfig} from "../config/cities.ts";
const city: CityConfig = {id: "custom", name: "Custom", tz: "UTC", available: true, center: {lat: 1, lon: 1}, bbox: {minLat: 0, minLon: 0, maxLat: 2, maxLon: 2}};
beforeEach(async () => {vi.restoreAllMocks(); await db.open(); await Promise.all(db.tables.map(table => table.clear()));});
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

it("preserves unclassified legacy transfer references without cloning live raw bytes on removal", async () => {
  await seed(city.id); await saveDeviceCity(city);
  await seed("live");
  await db.ptbBytes.put({...(await db.ptbBytes.get("live"))!, transfersArtifact: {url: "/transfer", hash: "live-hash", sizeBytes: 1}});
  await db.offlineTransfers.bulkPut([{hash: "live-hash", bytes: new Uint8Array([1])}, {hash: "unused", bytes: new Uint8Array([2])}]);
  const read = vi.fn((value: unknown) => value);
  db.ptbBytes.hook("reading", read);
  try {
    await removeDeviceCity(city.id);
    expect(read).not.toHaveBeenCalled();
  } finally {db.ptbBytes.hook("reading").unsubscribe(read);}
  expect(await hasLiveDeviceCity("live")).toBe(true);
  // An old raw cache has no compact transfer inventory. Conservatively retain
  // its unclassified hashes until legacy ownership can be resolved.
  expect(await db.offlineTransfers.get("unused")).toBeDefined();
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

it("lists download metadata without materializing timetable payloads", async () => {
  for (let i = 0; i < 8; i++) {
    await seed(`city-${i}`);
    await saveDeviceCity({...city, id: `city-${i}`});
  }
  const read = vi.fn((row: unknown) => row);
  db.offlineCities.hook("reading", read);
  try {
    const downloads = await listDeviceCities();
    expect(downloads).toHaveLength(8);
    expect(downloads.every(row => row.state === "complete" && !("tables" in row))).toBe(true);
    expect(read).not.toHaveBeenCalled();
  } finally { db.offlineCities.hook("reading").unsubscribe(read); }
});

it("fills selected legacy metadata only after successful restore and keeps its date", async () => {
  await seed(city.id); await saveDeviceCity(city);
  const original = (await db.offlineCityMetadata.get(city.id))!;
  await db.offlineCityMetadata.put({cityId: city.id, state: "legacy"});
  const controller = new AbortController(); controller.abort();
  await expect(restoreDeviceCity(city.id, controller.signal)).rejects.toThrow();
  expect(await db.offlineCityMetadata.get(city.id)).toEqual({cityId: city.id, state: "legacy"});
  expect(await restoreDeviceCity(city.id)).toBe(true);
  expect(await db.offlineCityMetadata.get(city.id)).toEqual(original);
  expect(await db.offlineCities.get(city.id)).toBeDefined();
});

it("rolls back a package replacement if its metadata cannot commit", async () => {
  await seed(city.id); await saveDeviceCity(city);
  const prior = await db.offlineCities.get(city.id);
  const metadata = await db.offlineCityMetadata.get(city.id);
  await seed(city.id);
  vi.spyOn(db.offlineCityMetadata, "put").mockRejectedValueOnce(new Error("quota"));
  await expect(saveDeviceCity(city)).rejects.toThrow("quota");
  expect(await db.offlineCities.get(city.id)).toEqual(prior);
  expect(await db.offlineCityMetadata.get(city.id)).toEqual(metadata);
});

it("does not collect unknown legacy transfer references or read other payloads on removal", async () => {
  await seed(city.id); await saveDeviceCity(city);
  await db.offlineCities.put({cityId: "legacy", city: {...city, id: "legacy"}, preparedAt: 1, sizeBytes: 1, tables: {}});
  await db.offlineCityMetadata.put({cityId: "legacy", state: "legacy"});
  await db.offlineTransfers.put({hash: "legacy-transfer", bytes: new Uint8Array([1])});
  const read = vi.fn((row: unknown) => row);
  db.offlineCities.hook("reading", read);
  try {
    await removeDeviceCity(city.id);
    expect(await db.offlineTransfers.get("legacy-transfer")).toBeDefined();
    expect(read).not.toHaveBeenCalled();
  } finally { db.offlineCities.hook("reading").unsubscribe(read); }
});

it("reconciles legacy package keys added or removed by an older reader without cloning payloads", async () => {
  await seed(city.id); await saveDeviceCity(city);
  await db.offlineCities.delete(city.id);
  await db.offlineCities.put({cityId: "older-reader", city, preparedAt: 1, sizeBytes: 1, tables: {}});
  const read = vi.fn((row: unknown) => row);
  db.offlineCities.hook("reading", read);
  try {
    expect(await listDeviceCities()).toEqual([{cityId: "older-reader", state: "legacy"}]);
    expect(read).not.toHaveBeenCalled();
  } finally { db.offlineCities.hook("reading").unsubscribe(read); }
});

it("rejects foreign legacy ownership before reading either large payload", async () => {
  await seed("owner");
  const raw = vi.spyOn(db.ptbBytes, "get");
  const bundle = vi.spyOn(db.gtfsBundle, "get");
  expect(await hasLiveDeviceCity("foreign")).toBe(false);
  expect(raw).not.toHaveBeenCalled();
  expect(bundle).not.toHaveBeenCalled();
});
