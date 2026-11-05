import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { PoiBundle } from "@pt/shared";

vi.mock("./brotliDecode.ts", () => ({
  decompressBrotli: vi.fn(async (buffer: ArrayBuffer) => new TextDecoder().decode(buffer)),
}));
vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(), notifyWriteGrew: vi.fn(), onQuotaNear: vi.fn(async () => []),
}));
vi.mock("./errorReporter.ts", () => ({ reportError: vi.fn() }));

const release = "a".repeat(64);
function bundle(version: string, date: string): PoiBundle {
  return {
    meta: {
      cityId: "gdansk", tier: "strict", version, entryCount: 0,
      attribution: "© OpenStreetMap contributors",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      bundleGeneratedAt: date, sourcePbfTimestamp: date,
    },
    entries: [],
  };
}
async function serve(value: PoiBundle, revision: number, tamper = false) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const manifest = {
    schemaVersion: 1, activationRevision: revision, baseUrl: `/poi/releases/${release}/`,
    bundles: [{cityId: "gdansk", filename: "gdansk.br", sizeBytes: bytes.length, sha256: hash}],
  };
  const fetchMock = vi.fn(async (url: string) =>
    url === "/poi/manifest.json" ? Response.json(manifest) :
      url === `/poi/releases/${release}/gdansk.br` ?
        new Response(tamper ? new Uint8Array(bytes.length) : bytes) :
        new Response(null, {status: 404}));
  vi.stubGlobal("fetch", fetchMock);
  const { __resetPoiManifestForTests } = await import("./poiManifest.ts");
  __resetPoiManifestForTests();
  return fetchMock;
}
describe("managed POI bundle resources", () => {
  beforeEach(async () => {
    vi.resetModules();
    await Dexie.delete("ptn");
  });
  afterEach(async () => {
    const { db } = await import("../db/index.ts");
    db.close();
    await Dexie.delete("ptn");
    vi.unstubAllGlobals();
  });
  it("uses immutable URLs, accepts rollback and rejects delayed older activations", async () => {
    const { fetchPoiBundle, syncPoiBundle } = await import("./poiLoader.ts");
    const fetchMock = await serve(bundle("new", "2026-10-20"), 2);
    const current = (await fetchPoiBundle("gdansk"))!;
    expect(current).not.toBeNull();
    expect(await syncPoiBundle("gdansk", current)).toBe(true);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/poi/manifest.json", `/poi/releases/${release}/gdansk.br`,
    ]);
    await serve(bundle("old", "2026-10-01"), 3);
    const rollback = (await fetchPoiBundle("gdansk"))!;
    expect(await syncPoiBundle("gdansk", rollback)).toBe(true);
    expect(await syncPoiBundle("gdansk", current)).toBe(false);
    const {db} = await import("../db/index.ts");
    expect((await db.poiSyncMeta.get("gdansk"))?.activeBundleHash).toBe("old");
  });
  it("installs the whole bundle for a city whose release has no tile contract", async () => {
    const {fetchPoiBundle, syncPoiBundle} = await import("./poiLoader.ts");
    const {getCityPoiTiling} = await import("./poiManifest.ts");
    await serve(bundle("untiled", "2026-10-20"), 2);
    expect(await getCityPoiTiling("gdansk")).toBeNull();
    const fallback = (await fetchPoiBundle("gdansk"))!;
    expect(fallback).not.toBeNull();
    expect(await syncPoiBundle("gdansk", fallback)).toBe(true);
    const {db} = await import("../db/index.ts");
    expect((await db.poiSyncMeta.get("gdansk"))?.activeBundleHash).toBe("untiled");
  });
  it("rejects checksum corruption without overwriting cached data", async () => {
    const {fetchPoiBundle, syncPoiBundle} = await import("./poiLoader.ts");
    await serve(bundle("good", "2026-10-01"), 1);
    await syncPoiBundle("gdansk", (await fetchPoiBundle("gdansk"))!);
    await serve(bundle("bad", "2026-10-20"), 2, true);
    expect(await fetchPoiBundle("gdansk")).toBeNull();
    const {db} = await import("../db/index.ts");
    expect((await db.poiSyncMeta.get("gdansk"))?.activeBundleHash).toBe("good");
  });
  it("revalidates discovery after its TTL in a long-lived page", async () => {
    const fetchMock = await serve(bundle("current", "2026-10-01"), 1);
    const {discoverPoiBundleResource} = await import("./poiManifest.ts");
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(100_000);
    try {
      await discoverPoiBundleResource("gdansk", "strict");
      await discoverPoiBundleResource("gdansk", "strict");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(161_000);
      await discoverPoiBundleResource("gdansk", "strict");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it("reports a deployment without a manifest as not deployed", async () => {
    const {discoverPoiBundleResource, __resetPoiManifestForTests} = await import("./poiManifest.ts");
    for (const response of [
      () => new Response("", {status: 404}),
      () => new Response("<!doctype html>", {status: 200, headers: {"content-type": "text/html"}}),
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => response()));
      __resetPoiManifestForTests();
      expect(await discoverPoiBundleResource("gdansk", "strict")).toBe("not-deployed");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", {status: 503})));
    __resetPoiManifestForTests();
    expect(await discoverPoiBundleResource("gdansk", "strict")).toBeNull();
  });
  it("rejects external or mutable manifest resource locations", async () => {
    const {discoverPoiBundleResource, __resetPoiManifestForTests} = await import("./poiManifest.ts");
    for (const baseUrl of ["https://example.com/poi/", "/poi/current/", "//example.com/"]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({
        schemaVersion: 1, activationRevision: 1, baseUrl, bundles: [],
      })));
      __resetPoiManifestForTests();
      expect(await discoverPoiBundleResource("gdansk", "strict")).toBeNull();
    }
  });
});
