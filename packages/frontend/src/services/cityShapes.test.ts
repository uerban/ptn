import "fake-indexeddb/auto";
import {beforeEach, afterEach, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {db} from "../db/index.ts";
import {fetchCityShapes} from "./cityShapes.ts";
import {clearSharedArtifactMemory, ensureSharedArtifactStored} from "./sharedCityArtifacts.ts";
import {CITIES} from "../config/cities.ts";
import {prepareCityArtifact, publishCityArtifact, pinCityArtifact} from "./cityArtifacts.ts";
import {clearDownloadedData} from "./dataDeletion.ts";

const body = JSON.stringify({shapes: [{shapeId: "shape", encodedPolyline: "abc", source: "gtfs"}]});
const bytes = new TextEncoder().encode(body);
const hash = createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {clearSharedArtifactMemory(); await db.delete(); await db.open();});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

it("restores verified shape geometry offline after the memory cache is gone", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(body)); vi.stubGlobal("fetch", fetcher);
  const first = await fetchCityShapes("/shapes", hash);
  await ensureSharedArtifactStored("shapes", hash);
  clearSharedArtifactMemory();
  fetcher.mockRejectedValue(new Error("offline"));
  expect(await fetchCityShapes("/shapes", hash)).toEqual(first);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("rejects corrupt disk and network bytes", async () => {
  await db.cityShapes.put({hash, bytes: new Uint8Array([9])});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("wrong")));
  await expect(fetchCityShapes("/shapes", hash)).rejects.toThrow("hash mismatch");
});

it("pins shape bytes with the city and includes their size without snapshotting rows", async () => {
  const city = CITIES[0];
  const raw = new Uint8Array([1]);
  const rawHash = createHash("sha256").update(raw).digest("hex");
  const artifact = await prepareCityArtifact(city.id, {generationId: "a", bundleSha256: rawHash,
    generatedAt: "today", cityTzIana: "UTC", shapesArtifact: {url: "/shapes", hash, sizeBytes: bytes.byteLength}},
    {bytes: raw, etag: `"${rawHash}"`, fromCache: false, networkValidated: true, transfersResolved: true});
  await publishCityArtifact(artifact, null);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  await pinCityArtifact(city, artifact.key);
  expect(await db.offlineCityMetadata.get(city.id)).toMatchObject({shapesHash: hash, sizeBytes: raw.byteLength + bytes.byteLength});
  expect(await db.offlineCities.count()).toBe(0);
  clearSharedArtifactMemory();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect((await fetchCityShapes("/shapes", hash))[0].shapeId).toBe("shape");
});

it("does not recreate a download cleared while its shape request was pending", async () => {
  const city = CITIES[0];
  const raw = new Uint8Array([1]);
  const rawHash = createHash("sha256").update(raw).digest("hex");
  const artifact = await prepareCityArtifact(city.id, {generationId: "a", bundleSha256: rawHash,
    generatedAt: "today", cityTzIana: "UTC", shapesArtifact: {url: "/shapes", hash, sizeBytes: bytes.byteLength}},
    {bytes: raw, etag: `"${rawHash}"`, fromCache: false, networkValidated: true, transfersResolved: true});
  await publishCityArtifact(artifact, null);
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockReturnValue(new Promise(resolve => {finish = resolve;}));
  vi.stubGlobal("fetch", fetcher);
  const pending = pinCityArtifact(city, artifact.key, artifact);
  const rejected = expect(pending).rejects.toMatchObject({name: "AbortError"});
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await clearDownloadedData({stopDownloadedRuntime: async () => {},
    cacheStorage: {keys: async () => [], delete: async () => true}});
  finish(new Response(body));
  await rejected;
  expect(await db.offlineCityMetadata.count()).toBe(0);
  expect(await db.cityArtifacts.count()).toBe(0);
  expect(await db.cityShapes.count()).toBe(0);
});
