import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import "fake-indexeddb/auto";
import {clearWalkGraphStore, openWalkGraphStore} from "./walkGraphStore.ts";
import {artifactSha256, discoverWalkGraph} from "./walkGraphResource.ts";
import {managedWalkGraphArtifacts, readLastGoodGraph, rememberGoodGraph} from "./walkGraphOffline.ts";
import {createWalkGraphHost} from "./walkGraphWorkerHost.ts";

const GOOD = new Uint8Array([0x50, 0x54, 0x57, 0x47, 1]);
const BAD = new Uint8Array([0x50, 0x54, 0x57, 0x47, 0]);
async function repository(bytes: Uint8Array<ArrayBuffer>, revision: number) {
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, city: "oslo", components: {walkGraph: {
      status: "present", format: "ptwg", formatVersion: 2, compression: "brotli",
      sha256: await artifactSha256(bytes.buffer), bytes: bytes.length, decodedBytes: bytes.length,
    }},
  }));
  const release = await artifactSha256(manifest.buffer);
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    url === "/osm/current/oslo.json" ? Response.json({schemaVersion: 1, release, revision}) :
      url === `/osm/releases/${release}/manifest.json` ? new Response(manifest) :
        url === `/osm/releases/${release}/walk-graph.ptwg.br` ? new Response(bytes) :
          new Response(null, {status: 404}));
  const discovered = await discoverWalkGraph("oslo", fetcher);
  if (discovered.kind !== "present") throw new Error("missing fixture");
  return {fetcher, resource: discovered.resource};
}

describe("last native-validated walk graph", () => {
  beforeEach(async () => {await clearWalkGraphStore();});
  afterEach(async () => {await clearWalkGraphStore();});

  it("allows higher revision rollback and rejects delayed writers or corrupt bytes", async () => {
    const old = await repository(GOOD, 1);
    const current = await repository(BAD, 2);
    await rememberGoodGraph(current.resource, BAD.buffer);
    expect(await rememberGoodGraph(old.resource, GOOD.buffer)).toBe(false);
    const rollback = {...old.resource, revision: 3};
    expect(await rememberGoodGraph(rollback, GOOD.buffer)).toBe(true);
    await expect(rememberGoodGraph({...current.resource, revision: 4}, GOOD.buffer)).rejects.toThrow();
    expect((await readLastGoodGraph("oslo"))?.resource).toEqual(rollback);
    expect(await rememberGoodGraph(current.resource, BAD.buffer)).toBe(false);
  });

  it("serializes independent connections so a delayed writer cannot undo rollback", async () => {
    const repo = await repository(GOOD, 1);
    await Promise.all([
      rememberGoodGraph({...repo.resource, revision: 3}, GOOD.buffer),
      rememberGoodGraph({...repo.resource, revision: 2}, GOOD.buffer),
    ]);
    expect((await readLastGoodGraph("oslo"))?.resource.revision).toBe(3);
    await clearWalkGraphStore();
    expect(await readLastGoodGraph("oslo")).toBeNull();
  });

  it("retains active guidance and falls back sequentially after a bad next-session update", async () => {
    let repositoryState = await repository(GOOD, 1);
    const fetcher: typeof fetch = url => repositoryState.fetcher(url);
    let live = 0;
    let peak = 0;
    let constructions = 0;
    const makeHost = () => createWalkGraphHost({
      fetch: fetcher, artifacts: managedWalkGraphArtifacts(fetcher),
      decompress: async buffer => new Uint8Array(buffer),
      loadModule: async () => ({
        default: async () => {},
        PtWalkGraph: function(bytes: Uint8Array) {
          constructions++;
          if (bytes[4] === 0) throw new Error("native rejection");
          live++; peak = Math.max(peak, live);
          return {cityId: () => "oslo", route: () => ({coords: [], steps: [], distanceMeters: 1}),
            free: () => {live--;}};
        } as never,
      }),
    });
    let host = makeHost();
    expect(await host.handle({id: 1, op: "load", cityId: "oslo"})).toMatchObject({status: "ready"});
    const good = await readLastGoodGraph("oslo");
    repositoryState = await repository(BAD, 2);
    expect(await host.handle({id: 2, op: "load", cityId: "oslo"})).toMatchObject({status: "ready"});
    expect(constructions).toBe(1); // Active guidance keeps its exact graph.
    host.dispose();
    host = makeHost();
    expect(await host.handle({id: 3, op: "load", cityId: "oslo"})).toMatchObject({status: "ready"});
    expect(constructions).toBe(3); // Rejected candidate, then known-good.
    expect((await readLastGoodGraph("oslo"))?.resource).toEqual(good?.resource);
    expect(peak).toBe(1);
    host.dispose();
    expect(live).toBe(0);
  });

  it("bounds cached cities even when installs share one timestamp", async () => {
    const repo = await repository(GOOD, 1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      for (const cityId of ["b", "c", "d", "e", "a"]) {
        await rememberGoodGraph({...repo.resource, cityId}, GOOD.buffer);
      }
      const database = await openWalkGraphStore();
      const count = await new Promise(resolve => {
        const request = database.transaction("graphs").objectStore("graphs").count();
        request.onsuccess = () => resolve(request.result);
      });
      database.close();
      expect(count).toBe(4);
      expect(await readLastGoodGraph("a")).not.toBeNull();
    } finally {clock.mockRestore();}
  });

  it("serves the verified local copy offline and ignores damaged cached bytes", async () => {
    const repo = await repository(GOOD, 1);
    await rememberGoodGraph(repo.resource, GOOD.buffer);
    const offline = managedWalkGraphArtifacts(async () => {throw new Error("offline");});
    const candidate = await offline.load("oslo", new AbortController().signal);
    expect(candidate?.resource).toEqual(repo.resource);
    const database = await openWalkGraphStore();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("graphs", "readwrite");
      const store = tx.objectStore("graphs");
      const request = store.get("oslo");
      request.onsuccess = () => store.put({...request.result, compressed: BAD.buffer});
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    expect(await readLastGoodGraph("oslo")).toBeNull();
    await expect(offline.load("oslo", new AbortController().signal)).rejects.toThrow("offline");
  });
});
