import "fake-indexeddb/auto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {db} from "../db/index.ts";
import {CITIES} from "../config/cities.ts";
import {cityArtifactPointer, collectCityArtifacts, pinCityArtifact, prepareCityArtifact,
  publishCityArtifact, readCityArtifact, readCityArtifactSnapshot} from "./cityArtifacts.ts";
import {listDeviceCities, removeDeviceCity, hasLiveDeviceCity} from "./deviceCities.ts";
import {holdSharedArtifactReferences} from "./sharedCityArtifacts.ts";

import {clearSharedArtifactMemory} from "./sharedCityArtifacts.ts";
import {recalledCityArtifact, clearCityArtifactMemory} from "./cityArtifactMemory.ts";

const city = CITIES[0];
async function artifact(cityId = city.id, generationId = "a", byte = 1,
  transfersArtifact?: {url: string; hash: string; sizeBytes: number},
  shapesArtifact?: {url: string; hash: string; sizeBytes: number}) {
  const bytes = new Uint8Array([byte, byte, byte]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    value => value.toString(16).padStart(2, "0")).join("");
  return prepareCityArtifact(cityId, {generationId, bundleSha256: hash,
    generatedAt: "2026-11-07", cityTzIana: "UTC", shapesArtifact}, {
    bytes, etag: `"${hash}"`, networkValidated: true, fromCache: false, transfersResolved: true, transfersArtifact,
  });
}
beforeEach(async () => { clearCityArtifactMemory(); await db.delete(); await db.open(); });
afterEach(() => vi.restoreAllMocks());

it("publishes an immutable city generation and rejects an older refresh's pointer", async () => {
  const a = await artifact();
  const b = await artifact(city.id, "b", 2);
  expect(await publishCityArtifact(a, null)).toBe(true);
  expect(await publishCityArtifact(b, a.key)).toBe(true);
  expect(await publishCityArtifact(a, a.key)).toBe(false);
  expect(await cityArtifactPointer(city.id)).toBe(b.key);
  expect(Array.from((await readCityArtifact(city.id))!.ptb.bytes)).toEqual(Array.from(b.ptb.bytes));
  expect(Array.from((await db.cityArtifacts.get(a.key))!.ptb.bytes)).toEqual(Array.from(a.ptb.bytes));
});

it("rolls back a failed publication without replacing the previous complete generation", async () => {
  const a = await artifact();
  const b = await artifact(city.id, "b", 2);
  await publishCityArtifact(a, null);
  vi.spyOn(db.cityCachePointers, "put").mockRejectedValueOnce(new Error("quota"));
  await expect(publishCityArtifact(b, a.key)).rejects.toThrow("quota");
  expect(await cityArtifactPointer(city.id)).toBe(a.key);
  expect(await db.cityArtifacts.get(b.key)).toBeUndefined();
  expect(await db.cityArtifactMetadata.get(b.key)).toBeUndefined();
});

it("verifies content rather than trusting the ETag", async () => {
  const a = await artifact();
  await expect(prepareCityArtifact(city.id, a.generation,
    {...a.ptb, bytes: new Uint8Array([99])})).rejects.toThrow("content hash mismatch");
});

it("pins an older complete generation independently of the current city pointer", async () => {
  const a = await artifact();
  const b = await artifact(city.id, "b", 2);
  await publishCityArtifact(a, null);
  await pinCityArtifact(city, a.key);
  await publishCityArtifact(b, a.key);
  expect((await readCityArtifact(city.id))?.key).toBe(b.key);
  expect((await readCityArtifact(city.id, true))?.key).toBe(a.key);
  expect(await listDeviceCities()).toEqual([expect.objectContaining({cityId: city.id, artifactKey: a.key})]);
  await removeDeviceCity(city.id);
  expect(await listDeviceCities()).toEqual([]);
  expect((await readCityArtifact(city.id))?.key).toBe(b.key);
});

it("collects over-budget cities and orphan generations without reading their payloads", async () => {
  const pinned = await artifact();
  const active = await artifact("active");
  const old = await artifact("cached", "old");
  const recent = await artifact("cached", "new", 2);
  for (const item of [pinned, active, old]) await publishCityArtifact(item, null);
  await publishCityArtifact(recent, old.key);
  await pinCityArtifact(city, pinned.key);
  const read = vi.fn(() => { throw new Error("inactive payload materialized"); });
  db.cityArtifacts.hook("reading", read);
  try {
    await collectCityArtifacts(active.key, 0);
    expect(read).not.toHaveBeenCalled();
  } finally { db.cityArtifacts.hook("reading").unsubscribe(read); }
  expect(await cityArtifactPointer("cached")).toBeNull();
  expect((await db.cityArtifactMetadata.toArray()).map(row => row.key).sort()).toEqual([pinned.key, active.key].sort());
  expect(await db.cityArtifacts.get(pinned.key)).toBeDefined();
  expect(await db.cityArtifacts.get(active.key)).toBeDefined();
});

it("requires retained transfers before publishing a download pin", async () => {
  const walk = new Uint8Array([1]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", walk)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const a = await artifact(city.id, "a", 1, {url: "/transfers", hash, sizeBytes: 1});
  await publishCityArtifact(a, null);
  await expect(pinCityArtifact(city, a.key)).rejects.toThrow("transfers");
  expect(await db.offlineCityMetadata.count()).toBe(0);
  await db.offlineTransfers.put({hash, bytes: walk});
  await pinCityArtifact(city, a.key);
  expect(await db.offlineCityMetadata.count()).toBe(1);
});

it("can pin the displayed generation before background persistence without replacing a newer cache pointer", async () => {
  const displayed = await artifact();
  const newer = await artifact(city.id, "b", 2);
  await publishCityArtifact(newer, null);
  await pinCityArtifact(city, displayed.key, displayed);
  expect(await cityArtifactPointer(city.id)).toBe(newer.key);
  expect((await readCityArtifact(city.id, true))?.key).toBe(displayed.key);
});

it("discovers an ordinary cached city offline without reading any timetable payload", async () => {
  const a = await artifact();
  await publishCityArtifact(a, null);
  const forbidden = vi.fn(() => {throw new Error("availability cloned a timetable");});
  db.cityArtifacts.hook("reading", forbidden);
  try {
    expect(await hasLiveDeviceCity(city.id)).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await db.ptbBytes.count()).toBe(0);
    expect(await db.offlineCities.count()).toBe(0);
  } finally {db.cityArtifacts.hook("reading").unsubscribe(forbidden);}
});

it("counts shared sidecars once across cities and never reads their payloads during collection", async () => {
  const transfer = {url: "/transfers", hash: "shared-transfer", sizeBytes: 100};
  const shape = {url: "/shapes", hash: "shared-shape", sizeBytes: 50};
  const a = await artifact("a", "a", 1, transfer, shape);
  const b = await artifact("b", "b", 2, transfer, shape);
  await publishCityArtifact(a, null); await publishCityArtifact(b, null);
  await db.offlineTransfers.put({hash: transfer.hash, bytes: new Uint8Array(100)});
  await db.cityShapes.put({hash: shape.hash, bytes: new Uint8Array(50)});
  await db.sharedArtifactMetadata.bulkPut([
    {key: 'transfers:' + transfer.hash, kind: 'transfers', hash: transfer.hash, sizeBytes: 100, lastUsedAt: 1},
    {key: 'shapes:' + shape.hash, kind: 'shapes', hash: shape.hash, sizeBytes: 50, lastUsedAt: 1},
  ]);
  const forbidden = vi.fn(() => {throw new Error("collector cloned sidecar bytes");});
  db.offlineTransfers.hook("reading", forbidden); db.cityShapes.hook("reading", forbidden);
  try {
    await collectCityArtifacts(null, 156); // two 3-byte PTBs plus one 150-byte shared pair
    expect(await db.cityCachePointers.count()).toBe(2);
    await collectCityArtifacts(null, 155);
    expect(await db.cityCachePointers.count()).toBe(1);
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    db.offlineTransfers.hook("reading").unsubscribe(forbidden); db.cityShapes.hook("reading").unsubscribe(forbidden);
  }
});

it("protects unpublished active/download references and collects them after release", async () => {
  await db.offlineTransfers.put({hash: "pending", bytes: new Uint8Array([1])});
  await db.cityShapes.put({hash: "pending-shape", bytes: new Uint8Array([2])});
  await db.sharedArtifactMetadata.bulkPut([
    {key: "transfers:pending", kind: "transfers", hash: "pending", sizeBytes: 1, lastUsedAt: 1},
    {key: "shapes:pending-shape", kind: "shapes", hash: "pending-shape", sizeBytes: 1, lastUsedAt: 1},
  ]);
  const release = holdSharedArtifactReferences({transfersHash: "pending", shapesHash: "pending-shape"});
  try {
    await collectCityArtifacts(null, 0);
    expect(await db.offlineTransfers.count()).toBe(1);
    expect(await db.cityShapes.count()).toBe(1);
  } finally {release();}
  await collectCityArtifacts(null, 0);
  expect(await db.offlineTransfers.count()).toBe(0);
  expect(await db.cityShapes.count()).toBe(0);
  expect(await db.sharedArtifactMetadata.count()).toBe(0);
});


it("reuses verified bytes only behind the selected current or pinned generation", async () => {
  const a = await artifact();
  const b = await artifact(city.id, "b", 2);
  await publishCityArtifact(a, null);
  const first = await readCityArtifact(city.id);
  const payloadRead = vi.spyOn(db.cityArtifacts, "get");
  expect(await readCityArtifact(city.id)).toBe(first);
  expect(payloadRead).not.toHaveBeenCalled();
  await pinCityArtifact(city, a.key);
  await publishCityArtifact(b, a.key);
  expect((await readCityArtifact(city.id))?.key).toBe(b.key);
  expect(await readCityArtifact(city.id, true)).toBe(first);
  await db.cityCachePointers.delete(city.id);
  expect(await readCityArtifact(city.id)).toBeUndefined();
  expect(await readCityArtifact(city.id, true)).toBe(first);
});


it("does not repopulate binary memory when a verified read finishes after cache deletion", async () => {
  const a = await artifact();
  await publishCityArtifact(a, null);
  let release!: () => void, started!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
    started();
    await paused;
    return digest(algorithm, bytes);
  });
  const reading = readCityArtifact(city.id);
  await entered;
  clearSharedArtifactMemory();
  clearCityArtifactMemory();
  release();
  await reading;
  expect(recalledCityArtifact(a.key)).toBeUndefined();
});


it("pins verified resident bytes durably even when the old disk payload was lost or corrupted", async () => {
  const a = await artifact();
  await publishCityArtifact(a, null);
  const resident = (await readCityArtifact(city.id))!;
  await db.cityArtifacts.delete(a.key);
  expect(await readCityArtifact(city.id)).toBe(resident);
  await pinCityArtifact(city, a.key, resident);
  clearCityArtifactMemory();
  expect(Array.from((await readCityArtifact(city.id, true))!.ptb.bytes)).toEqual([1, 1, 1]);
  await db.cityArtifacts.put({...a, ptb: {...a.ptb, bytes: new Uint8Array([9])}});
  await pinCityArtifact(city, a.key, resident);
  clearCityArtifactMemory();
  expect(Array.from((await readCityArtifact(city.id, true))!.ptb.bytes)).toEqual([1, 1, 1]);
});


it("captures a preferred pin and its ordinary publication CAS boundary in one snapshot", async () => {
  const a = await artifact();
  const b = await artifact(city.id, "b", 2);
  const c = await artifact(city.id, "c", 3);
  await publishCityArtifact(a, null);
  await pinCityArtifact(city, a.key);
  await publishCityArtifact(b, a.key);
  const snapshot = await readCityArtifactSnapshot(city.id, true);
  expect(snapshot.artifact?.key).toBe(a.key);
  expect(snapshot.pointerKey).toBe(b.key);
  await publishCityArtifact(c, b.key);
  expect(await publishCityArtifact(snapshot.artifact!, snapshot.pointerKey)).toBe(false);
  expect(await cityArtifactPointer(city.id)).toBe(c.key);
});
