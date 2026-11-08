import "fake-indexeddb/auto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {db, type GtfsShapeRecord} from "../db/index.ts";
import {useCityStore} from "../stores/cityStore.ts";
import {activateCityData, CityDataContext, invalidateCityData} from "./cityData.ts";
import {readLegacyCityShapes} from "./legacyCityShapes.ts";
import {prepareCityArtifact} from "./cityArtifacts.ts";

const city = useCityStore.getState().activeCity;
const shape: GtfsShapeRecord = {shapeId: "same-id", encodedPolyline: "legacy curve", source: "gtfs"};
function context(generationId = "g1") {
  return new CityDataContext({meta: {cityId: city.id, generatedAt: "today"}, stops: [], routes: [], calendar: []},
    {id: "current", cityId: city.id, generationId, etag: '"bytes"', generatedAt: "today", lastSynced: 1, shapesHash: "geometry"});
}
beforeEach(async () => {invalidateCityData(); await db.delete(); await db.open();});
afterEach(() => {invalidateCityData(); vi.restoreAllMocks();});

it("recovers only the selected saved generation without copying shared tables", async () => {
  const selected = context(); activateCityData(selected);
  await db.offlineCities.bulkPut([
    {cityId: city.id, city, preparedAt: 1, sizeBytes: 1, tables: {gtfsSyncMeta: [selected.meta], gtfsShapes: [shape]}},
    {cityId: "other", city: {...city, id: "other"}, preparedAt: 1, sizeBytes: 1, tables: {gtfsShapes: [{...shape, encodedPolyline: "foreign"}]}},
  ]);
  await db.gtfsShapes.put({...shape, encodedPolyline: "foreign live projection"});
  const read = vi.fn((value: {cityId: string}) => {
    if (value.cityId !== city.id) throw new Error("foreign package cloned");
    return value;
  });
  db.offlineCities.hook("reading", read);
  try {
    expect(await readLegacyCityShapes(selected)).toEqual([shape]);
    expect(read).toHaveBeenCalledOnce();
  } finally {db.offlineCities.hook("reading").unsubscribe(read);}
  expect((await db.gtfsShapes.get(shape.shapeId))?.encodedPolyline).toBe("foreign live projection");
});

it("rejects an older sidecar generation even when city, raw ETag and shape IDs match", async () => {
  const selected = context("new"); activateCityData(selected);
  await db.offlineCities.put({cityId: city.id, city, preparedAt: 1, sizeBytes: 1,
    tables: {gtfsSyncMeta: [{...selected.meta, generationId: "old"}], gtfsShapes: [shape]}});
  expect(await readLegacyCityShapes(selected)).toEqual([]);
});

it("reads live legacy rows only after their owning metadata matches", async () => {
  const selected = context(); activateCityData(selected);
  await db.gtfsShapes.put(shape);
  await db.gtfsSyncMeta.put({...selected.meta, cityId: "other"});
  const rows = vi.spyOn(db.gtfsShapes, "toArray");
  expect(await readLegacyCityShapes(selected)).toEqual([]);
  expect(rows).not.toHaveBeenCalled();
  await db.gtfsSyncMeta.put(selected.meta);
  expect(await readLegacyCityShapes(selected)).toEqual([shape]);
});

it("accepts historical truncated ETags only for the normalized legacy raw generation", async () => {
  const bytes = new Uint8Array([1]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  const artifact = await prepareCityArtifact(city.id, {generationId: hash, bundleSha256: hash, cityTzIana: "UTC", generatedAt: "today"},
    {bytes, etag: `"${hash}"`, fromCache: true, networkValidated: false, transfersResolved: true});
  const selected = new CityDataContext({meta: {cityId: city.id, generatedAt: "today"}, routes: [], stops: [], calendar: []},
    {id: "current", cityId: city.id, etag: `"${hash}"`, generationId: hash, generatedAt: "today", lastSynced: 1}, [], artifact);
  activateCityData(selected);
  await db.offlineCities.put({cityId: city.id, city, preparedAt: 1, sizeBytes: 1,
    tables: {gtfsSyncMeta: [{...selected.meta, generationId: undefined, etag: `"${hash.slice(0, 32)}"`}], gtfsShapes: [shape]}});
  expect(await readLegacyCityShapes(selected)).toEqual([shape]);
});

it("discards a geometry read after its owning context was replaced", async () => {
  const selected = context(); activateCityData(selected);
  const Dexie = (await import("dexie")).default;
  let finish!: (value: GtfsShapeRecord[]) => void;
  vi.spyOn(db, "transaction").mockReturnValueOnce(new Dexie.Promise<GtfsShapeRecord[]>(resolve => {finish = resolve;}));
  const pending = readLegacyCityShapes(selected);
  activateCityData(context("new"));
  finish([shape]);
  expect(await pending).toEqual([]);
});
