import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { PoiManifest, PoiTileManifest } from "@pt/shared";

const SHA256 = "a".repeat(64);
const ANCHOR = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };

function manifest(
  schemaVersion: number,
  options: {
    sha256?: string;
    deliveryActive?: boolean;
    tile?: Partial<PoiTileManifest>;
  } = {},
): PoiManifest {
  return {
    schemaVersion,
    bundles: [
      {
        cityId: "gdansk",
        filename: "gdansk.br",
        sizeBytes: 1,
        sha256: options.sha256,
        poiTile: {
          edgeKm: 24,
          anchor: ANCHOR,
          tileBounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 },
          tilingPolicy: "k-anon-floor",
          kAnonWaived: false,
          deliveryActive: options.deliveryActive ?? true,
          ...options.tile,
        },
      },
      {
        cityId: "vilnius",
        filename: "vilnius.br",
        sizeBytes: 1,
        sha256: SHA256,
      },
    ],
  };
}

function mockManifest(value: PoiManifest): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => value,
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("getCityPoiTiling", () => {
  beforeEach(async () => {
    vi.resetModules();
    await Dexie.delete("ptn");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { db } = await import("../db/index.ts");
    db.close();
    await Dexie.delete("ptn");
  });

  it.each([0, 2, 3])("treats schemaVersion %i as inactive for tiled delivery", async (version) => {
    mockManifest(manifest(version, { sha256: SHA256 }));
    const { getCityPoiTiling } = await import("./poiManifest.ts");

    expect(await getCityPoiTiling("gdansk")).toBeNull();
  });

  it("returns active tiling with the strict bundle generation", async () => {
    mockManifest(manifest(1, { sha256: SHA256 }));
    const { getCityPoiTiling } = await import("./poiManifest.ts");

    expect(await getCityPoiTiling("gdansk")).toEqual({
      edgeKm: 24,
      anchor: ANCHOR,
      bundleSha256: SHA256,
      generationId: expect.stringMatching(/^[0-9a-f]{64}$/),
      tileBounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 },
    });
  });

  it.each([
    ["missing", undefined],
    ["uppercase", "A".repeat(64)],
    ["short", "a".repeat(63)],
    ["non-hex", `${"a".repeat(63)}g`],
  ])("rejects a %s strict bundle sha256", async (_label, sha256) => {
    mockManifest(manifest(1, { sha256 }));
    const { getCityPoiTiling } = await import("./poiManifest.ts");

    expect(await getCityPoiTiling("gdansk")).toBeNull();
  });

  it("requires deliveryActive and a strict poiTile block", async () => {
    mockManifest(manifest(1, { sha256: SHA256, deliveryActive: false }));
    const { getCityPoiTiling } = await import("./poiManifest.ts");

    expect(await getCityPoiTiling("gdansk")).toBeNull();
    expect(await getCityPoiTiling("vilnius")).toBeNull();
  });

  it("revalidates the manifest once per page and reuses one promise across cities", async () => {
    const fetchMock = mockManifest(manifest(1, { sha256: SHA256 }));
    const { getCityPoiTiling } = await import("./poiManifest.ts");

    await Promise.all([
      getCityPoiTiling("gdansk"),
      getCityPoiTiling("vilnius"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/poi/manifest.json", {
      cache: "no-cache",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("changes the local generation when the tiling contract changes but keeps the API bundle SHA", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => manifest(1, { sha256: SHA256 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          manifest(1, {
            sha256: SHA256,
            tile: { edgeKm: 20 },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./poiManifest.ts");

    const first = await mod.getCityPoiTiling("gdansk");
    mod.__resetPoiManifestForTests();
    const second = await mod.getCityPoiTiling("gdansk");

    expect(first?.bundleSha256).toBe(SHA256);
    expect(second?.bundleSha256).toBe(SHA256);
    expect(second?.generationId).not.toBe(first?.generationId);
  });

  it("uses a digest-validated persisted contract only for transport failure", async () => {
    mockManifest(manifest(1, { sha256: SHA256 }));
    const mod = await import("./poiManifest.ts");
    const online = await mod.getCityPoiTiling("gdansk");

    mod.__resetPoiManifestForTests();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await mod.getCityPoiTiling("gdansk")).toEqual(online);

    mod.__resetPoiManifestForTests();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect(await mod.getCityPoiTiling("gdansk")).toBeNull();

    const { db } = await import("../db/index.ts");
    const stored = await db.poiTileGenerations.get("gdansk");
    await db.poiTileGenerations.put({ ...stored!, edgeKm: 99 });
    mod.__resetPoiManifestForTests();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await mod.getCityPoiTiling("gdansk")).toBeNull();
    expect(await db.poiTileGenerations.get("gdansk")).toBeUndefined();
  });

  it("does not activate a manifest response invalidated while its fetch is in flight", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    const mod = await import("./poiManifest.ts");

    const pending = mod.getCityPoiTiling("gdansk");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await mod.invalidateCityPoiTiling("gdansk");
    response.resolve({
      ok: true,
      json: async () => manifest(1, { sha256: SHA256 }),
    } as Response);

    expect(await pending).toBeNull();
    expect(mod.getActiveCityPoiTiling("gdansk", SHA256)).toBeNull();
    const { db } = await import("../db/index.ts");
    expect(await db.poiTileGenerations.get("gdansk")).toBeUndefined();
  });

  it("retries offline preparation when a newer cross-tab generation wins after the read", async () => {
    mockManifest(manifest(1, { sha256: SHA256 }));
    const mod = await import("./poiManifest.ts");
    await mod.getCityPoiTiling("gdansk");
    const { db } = await import("../db/index.ts");
    const stale = await db.poiTileGenerations.get("gdansk");

    mod.__resetPoiManifestForTests();
    mockManifest(manifest(1, {
      sha256: "b".repeat(64),
      tile: { edgeKm: 20 },
    }));
    const newerTiling = await mod.getCityPoiTiling("gdansk");
    const newer = await db.poiTileGenerations.get("gdansk");
    expect(stale).toBeDefined();
    expect(newer).toBeDefined();

    await db.poiTileGenerations.put(stale!);
    const readGeneration = db.poiTileGenerations.get.bind(
      db.poiTileGenerations,
    );
    const interceptRead = async (cityId: string) => {
      const read = await readGeneration(cityId);
      await db.poiTileGenerations.put(newer!);
      return read;
    };
    vi.spyOn(db.poiTileGenerations, "get").mockImplementationOnce(
      interceptRead as typeof db.poiTileGenerations.get,
    );
    mod.__resetPoiManifestForTests();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    expect(await mod.getCityPoiTiling("gdansk")).toEqual(newerTiling);
    expect(await db.poiTileGenerations.get("gdansk")).toEqual(newer);
  });

  it.each(["offline rejection", "non-ok response"])(
    "retries after an %s instead of caching null for the page lifetime",
    async (failure) => {
      const fetchMock = vi.fn();
      if (failure === "offline rejection") {
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      } else {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 503,
        } as Response);
      }
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => manifest(1, { sha256: SHA256 }),
      } as Response);
      vi.stubGlobal("fetch", fetchMock);
      const { getCityPoiTiling } = await import("./poiManifest.ts");

      expect(await getCityPoiTiling("gdansk")).toBeNull();
      expect(await getCityPoiTiling("gdansk")).toEqual({
        edgeKm: 24,
        anchor: ANCHOR,
        bundleSha256: SHA256,
        generationId: expect.stringMatching(/^[0-9a-f]{64}$/),
        tileBounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});
