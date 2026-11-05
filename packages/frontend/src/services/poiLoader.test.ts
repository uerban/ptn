import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { PoiBundle, PoiEntry } from "@pt/shared";

// Discovery is exercised end-to-end in poiResources.test.ts. Loader unit tests
// provide immutable descriptors while retaining real size/checksum validation.
const resources = vi.hoisted(() => ({ bodies: new Map<string, Uint8Array>() }));
vi.mock("./poiManifest.ts", () => ({
  discoverPoiBundleResource: vi.fn(async (city: string, tier: string) => {
    const filename = tier === "loose" ? city + ".loose.br" : city + ".br";
    const bytes = resources.bodies.get(filename) ?? new Uint8Array(1);
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return {
      url: "/poi/releases/" + "a".repeat(64) + "/" + filename,
      sizeBytes: bytes.length, activationRevision: 1,
      sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    };
  }),
}));

vi.mock("./brotliDecode.ts", () => ({
  decompressBrotli: vi.fn(async (buffer: ArrayBuffer) =>
    new TextDecoder().decode(buffer),
  ),
}));

vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
  notifyWriteGrew: vi.fn().mockResolvedValue(undefined),
  onQuotaNear: vi.fn().mockResolvedValue([]),
}));

vi.mock("./errorReporter.ts", () => ({
  reportError: vi.fn(),
}));

function makeEntry(
  id: string,
  name: string,
  overrides?: Partial<PoiEntry>,
): PoiEntry {
  return {
    id,
    name,
    aliases: { en: ["English Name"] },
    category: "public_building",
    lat: 54.35,
    lon: 18.64,
    source: "curated",
    rankBoost: 1.0,
    tier: "strict",
    ...overrides,
  };
}

function makeBundle(overrides?: {
  meta?: Partial<PoiBundle["meta"]>;
  entries?: PoiEntry[];
}): PoiBundle {
  return {
    meta: {
      cityId: "gdansk",
      version: "hash-v1",
      attribution: "\u00a9 OpenStreetMap contributors",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      sourcePbfTimestamp: "2026-04-01T00:00:00Z",
      bundleGeneratedAt: "2026-04-10T12:00:00Z",
      tier: "strict",
      entryCount: overrides?.entries?.length ?? 2,
      ...overrides?.meta,
    },
    entries: overrides?.entries ?? [
      makeEntry("poi-1", "Dworzec Glowny"),
      makeEntry("poi-2", "Ratusz"),
    ],
  };
}

function mockFetchWith(bundle: PoiBundle): void {
  const encoded = new TextEncoder().encode(JSON.stringify(bundle));
  resources.bodies.set(bundle.meta.cityId + (bundle.meta.tier === "loose" ? ".loose.br" : ".br"), encoded);
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(encoded, { status: 200 }),
  );
}

function mockFetchByUrl(urlBundleMap: Record<string, PoiBundle | null>): void {
  for (const [url, bundle] of Object.entries(urlBundleMap)) {
    if (bundle) resources.bodies.set(url.split("/").at(-1)!, new TextEncoder().encode(JSON.stringify(bundle)));
  }
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const bundle = urlBundleMap["/poi/" + url.split("/").at(-1)];
    if (bundle === null || bundle === undefined) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const encoded = new TextEncoder().encode(JSON.stringify(bundle));
    return Promise.resolve(new Response(encoded, { status: 200 }));
  });
}

describe("poiLoader", () => {
  const originalFetch = globalThis.fetch;
  let originalSw: ServiceWorkerContainer;

  beforeEach(async () => {
    resources.bodies.clear();
    await Dexie.delete("ptn");
    const { db } = await import("../db/index.ts");
    await db.open();
    originalSw = navigator.serviceWorker;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try {
      Object.defineProperty(navigator, "serviceWorker", {
        value: originalSw,
        configurable: true,
      });
    } catch {
      // navigator.serviceWorker may not be configurable in some envs
    }
    const { db } = await import("../db/index.ts");
    db.close();
    await Dexie.delete("ptn");
  });

  describe("syncMetaKey", () => {
    it("returns cityId for strict tier", async () => {
      const { syncMetaKey } = await import("./poiLoader.ts");
      expect(syncMetaKey("gdansk", "strict")).toBe("gdansk");
    });

    it("returns cityId:loose for loose tier", async () => {
      const { syncMetaKey } = await import("./poiLoader.ts");
      expect(syncMetaKey("gdansk", "loose")).toBe("gdansk:loose");
    });
  });

  describe("computeGeoBucket", () => {
    it("floors lat and lon to 0.01-degree grid (~1km)", async () => {
      const { computeGeoBucket } = await import("./poiLoader.ts");
      expect(computeGeoBucket(54.35, 18.64)).toBe("5435_1864");
      expect(computeGeoBucket(54.999, 18.001)).toBe("5499_1800");
      expect(computeGeoBucket(55.0, 19.0)).toBe("5500_1900");
    });

    it("handles negative coordinates", async () => {
      const { computeGeoBucket } = await import("./poiLoader.ts");
      expect(computeGeoBucket(-33.87, 151.21)).toBe("-3387_15121");
      expect(computeGeoBucket(40.71, -74.01)).toBe("4071_-7402");
    });
  });

  describe("entryToRecord", () => {
    it("converts PoiEntry to PoiIndexRecord with computed geoBucket", async () => {
      const { entryToRecord } = await import("./poiLoader.ts");
      const entry = makeEntry("poi-1", "Dworzec Glowny", {
        lat: 54.35,
        lon: 18.64,
        wikidataId: "Q123",
        osmId: "node/456",
        nearestStopGroupId: "sg-1",
      });
      const record = entryToRecord(entry, "gdansk");

      expect(record).toEqual({
        id: "gdansk:poi-1",
        cityId: "gdansk",
        name: "Dworzec Glowny",
        geoBucket: "5435_1864",
        aliases: { en: ["English Name"] },
        category: "public_building",
        lat: 54.35,
        lon: 18.64,
        source: "curated",
        rankBoost: 1.0,
        tier: "strict",
        wikidataId: "Q123",
        nearestStopGroupId: "sg-1",
        osmId: "node/456",
      });
    });

    it("uses cityId from argument, not from entry", async () => {
      const { entryToRecord } = await import("./poiLoader.ts");
      const entry = makeEntry("poi-1", "Test");
      const record = entryToRecord(entry, "vilnius");
      expect(record.cityId).toBe("vilnius");
    });
  });

  describe("syncPoiBundle", () => {
    it("inserts entries and creates sync meta on first load", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const bundle = makeBundle();
      const changed = await syncPoiBundle("gdansk", bundle);

      expect(changed).toBe(true);
      expect(await db.poiIndex.count()).toBe(2);

      const meta = await db.poiSyncMeta.get("gdansk");
      expect(meta?.activeBundleHash).toBe("hash-v1");
      expect(meta?.entryCount).toBe(2);
      expect(meta?.tier).toBe("strict");
      expect(meta?.sourcePbfTimestamp).toBe("2026-04-01T00:00:00Z");
      expect(meta?.bundleGeneratedAt).toBe("2026-04-10T12:00:00Z");
    });

    it("installs every row of a bundle larger than one write chunk", async () => {
      const { syncPoiBundle, POI_WRITE_CHUNK } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const count = POI_WRITE_CHUNK * 2 + 1;
      const entries = Array.from({ length: count }, (_, i) =>
        makeEntry(`poi-${i}`, `Place ${i}`));
      const changed = await syncPoiBundle(
        "gdansk",
        makeBundle({ meta: { entryCount: count }, entries }),
      );

      expect(changed).toBe(true);
      expect(await db.poiIndex.count()).toBe(count);
      expect((await db.poiSyncMeta.get("gdansk"))?.entryCount).toBe(count);
    });

    it("skips rebuild when hash matches", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");

      const bundle = makeBundle();
      await syncPoiBundle("gdansk", bundle);

      const changed = await syncPoiBundle("gdansk", bundle);
      expect(changed).toBe(false);
    });

    it("rebuilds index when hash changes", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const bundleV1 = makeBundle({
        meta: { version: "hash-v1" },
        entries: [makeEntry("poi-1", "Dworzec Glowny")],
      });
      await syncPoiBundle("gdansk", bundleV1);
      expect(await db.poiIndex.count()).toBe(1);

      const bundleV2 = makeBundle({
        meta: { version: "hash-v2", entryCount: 3 },
        entries: [
          makeEntry("poi-10", "Ratusz"),
          makeEntry("poi-11", "Biblioteka"),
          makeEntry("poi-12", "Fontanna Neptuna"),
        ],
      });
      const changed = await syncPoiBundle("gdansk", bundleV2);

      expect(changed).toBe(true);
      expect(await db.poiIndex.count()).toBe(3);

      const meta = await db.poiSyncMeta.get("gdansk");
      expect(meta?.activeBundleHash).toBe("hash-v2");
      expect(meta?.entryCount).toBe(3);

      const names = (await db.poiIndex.toArray()).map((r) => r.name).sort();
      expect(names).toEqual(["Biblioteka", "Fontanna Neptuna", "Ratusz"]);
    });

    it("skips write when existing data is newer (race condition guard)", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const newerBundle = makeBundle({
        meta: { version: "hash-new", bundleGeneratedAt: "2026-04-15T12:00:00Z" },
        entries: [makeEntry("poi-new", "New Place")],
      });
      await syncPoiBundle("gdansk", newerBundle);
      expect(await db.poiIndex.count()).toBe(1);

      const olderBundle = makeBundle({
        meta: { version: "hash-old", bundleGeneratedAt: "2026-04-10T12:00:00Z" },
        entries: [makeEntry("poi-old", "Old Place")],
      });
      const changed = await syncPoiBundle("gdansk", olderBundle);

      expect(changed).toBe(false);
      expect(await db.poiIndex.count()).toBe(1);
      const meta = await db.poiSyncMeta.get("gdansk");
      expect(meta?.activeBundleHash).toBe("hash-new");
    });

    it("isolates cities during rebuild", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      await syncPoiBundle(
        "gdansk",
        makeBundle({
          meta: { version: "gd-v1" },
          entries: [makeEntry("poi-gd-1", "Dworzec Glowny")],
        }),
      );
      await syncPoiBundle(
        "vilnius",
        makeBundle({
          meta: { cityId: "vilnius", version: "vil-v1" },
          entries: [makeEntry("poi-vil-1", "Katedra", { lat: 54.68, lon: 25.29 })],
        }),
      );
      expect(await db.poiIndex.count()).toBe(2);

      await syncPoiBundle(
        "gdansk",
        makeBundle({
          meta: { version: "gd-v2" },
          entries: [makeEntry("poi-gd-2", "Ratusz")],
        }),
      );

      expect(await db.poiIndex.count()).toBe(2);
      const vilniusEntries = await db.poiIndex
        .where("cityId")
        .equals("vilnius")
        .toArray();
      expect(vilniusEntries).toHaveLength(1);
      expect(vilniusEntries[0]!.name).toBe("Katedra");
    });

    it("notifies storage policy after write", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { notifyWriteGrew } = await import("./storagePolicy.ts");

      await syncPoiBundle("gdansk", makeBundle());
      expect(notifyWriteGrew).toHaveBeenCalled();
    });

    it("does not notify storage policy on skip", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { notifyWriteGrew } = await import("./storagePolicy.ts");

      await syncPoiBundle("gdansk", makeBundle());
      vi.mocked(notifyWriteGrew).mockClear();

      await syncPoiBundle("gdansk", makeBundle());
      expect(notifyWriteGrew).not.toHaveBeenCalled();
    });

    it("syncs strict and loose tiers independently", async () => {
      const { syncPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Dworzec", { tier: "strict" })],
      });
      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose", entryCount: 1 },
        entries: [makeEntry("poi-l1", "School", { tier: "loose" })],
      });

      await syncPoiBundle("gdansk", strictBundle);
      await syncPoiBundle("gdansk", looseBundle);

      expect(await db.poiIndex.count()).toBe(2);

      const strictMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "strict"));
      const looseMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"));
      expect(strictMeta?.activeBundleHash).toBe("strict-v1");
      expect(looseMeta?.activeBundleHash).toBe("loose-v1");
    });

    it("rebuilds only matching tier on hash change", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      await syncPoiBundle("gdansk", makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      }));
      await syncPoiBundle("gdansk", makeBundle({
        meta: { version: "loose-v1", tier: "loose" },
        entries: [makeEntry("poi-l1", "School", { tier: "loose" })],
      }));
      expect(await db.poiIndex.count()).toBe(2);

      await syncPoiBundle("gdansk", makeBundle({
        meta: { version: "loose-v2", tier: "loose" },
        entries: [
          makeEntry("poi-l2", "Mall", { tier: "loose" }),
          makeEntry("poi-l3", "Park", { tier: "loose" }),
        ],
      }));

      expect(await db.poiIndex.count()).toBe(3);
      const names = (await db.poiIndex.toArray()).map((r) => r.name).sort();
      expect(names).toEqual(["Mall", "Park", "Station"]);
    });

    it("stores computed geoBucket per entry", async () => {
      const { syncPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const bundle = makeBundle({
        entries: [
          makeEntry("poi-1", "Place A", { lat: 54.35, lon: 18.64 }),
          makeEntry("poi-2", "Place B", { lat: 54.68, lon: 18.27 }),
        ],
      });
      await syncPoiBundle("gdansk", bundle);

      const records = await db.poiIndex.toArray();
      const buckets = records.map((r) => r.geoBucket).sort();
      expect(buckets).toEqual(["5435_1864", "5468_1827"]);
    });
  });

  describe("clearPoiIndex", () => {
    it("clears all cities when no cityId given", async () => {
      const { syncPoiBundle, clearPoiIndex } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      await syncPoiBundle("gdansk", makeBundle({ meta: { version: "v1" } }));
      await syncPoiBundle(
        "vilnius",
        makeBundle({
          meta: { cityId: "vilnius", version: "v2" },
          entries: [makeEntry("poi-v", "Katedra")],
        }),
      );
      expect(await db.poiIndex.count()).toBe(3);

      await clearPoiIndex();
      expect(await db.poiIndex.count()).toBe(0);
      expect(await db.poiSyncMeta.count()).toBe(0);
    });

    it("clears only specified city", async () => {
      const { syncPoiBundle, clearPoiIndex } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      await syncPoiBundle("gdansk", makeBundle({ meta: { version: "v1" } }));
      await syncPoiBundle(
        "vilnius",
        makeBundle({
          meta: { cityId: "vilnius", version: "v2" },
          entries: [makeEntry("poi-v", "Katedra")],
        }),
      );

      await clearPoiIndex("gdansk");
      expect(await db.poiIndex.count()).toBe(1);
      const remaining = await db.poiIndex.toArray();
      expect(remaining[0]!.cityId).toBe("vilnius");
      expect(await db.poiSyncMeta.get("gdansk")).toBeUndefined();
      expect(await db.poiSyncMeta.get("vilnius")).toBeDefined();
    });
  });

  describe("fetchPoiBundle", () => {
    it("treats a deployment without a POI manifest as stops-only, not an error", async () => {
      const manifest = await import("./poiManifest.ts");
      vi.mocked(manifest.discoverPoiBundleResource).mockResolvedValueOnce("not-deployed");
      const { fetchPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
      globalThis.fetch = vi.fn() as unknown as typeof fetch;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(await fetchPoiBundle("gdansk")).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(getPoiLoadErrors().has("gdansk:strict")).toBe(false);
    });

    it("returns parsed bundle on successful fetch", async () => {
      const { fetchPoiBundle } = await import("./poiLoader.ts");
      const bundle = makeBundle();
      mockFetchWith(bundle);

      const result = await fetchPoiBundle("gdansk");
      expect(result).toEqual(bundle);
      expect(globalThis.fetch).toHaveBeenCalledWith("/poi/releases/" + "a".repeat(64) + "/gdansk.br", {
        cache: "force-cache", credentials: "omit", referrerPolicy: "no-referrer",
      });
    });

    it("fetches loose tier from correct URL", async () => {
      const { fetchPoiBundle } = await import("./poiLoader.ts");
      const bundle = makeBundle({ meta: { tier: "loose" } });
      mockFetchWith(bundle);

      const result = await fetchPoiBundle("gdansk", "loose");
      expect(result).toEqual(bundle);
      expect(globalThis.fetch).toHaveBeenCalledWith("/poi/releases/" + "a".repeat(64) + "/gdansk.loose.br", {
        cache: "force-cache", credentials: "omit", referrerPolicy: "no-referrer",
      });
    });

    it("returns null on 404", async () => {
      const { fetchPoiBundle } = await import("./poiLoader.ts");
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 404 }),
      );

      const result = await fetchPoiBundle("unknown");
      expect(result).toBeNull();
    });

    it("reports error on non-404 failure", async () => {
      const { fetchPoiBundle } = await import("./poiLoader.ts");
      const { reportError } = await import("./errorReporter.ts");
      vi.mocked(reportError).mockClear();

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 500 }),
      );

      const result = await fetchPoiBundle("gdansk");
      expect(result).toBeNull();
      expect(reportError).toHaveBeenCalled();
    });

    it("does not report error on 404", async () => {
      const { fetchPoiBundle } = await import("./poiLoader.ts");
      const { reportError } = await import("./errorReporter.ts");
      vi.mocked(reportError).mockClear();

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 404 }),
      );

      await fetchPoiBundle("gdansk");
      expect(reportError).not.toHaveBeenCalled();
    });

    it("returns null on network error", async () => {
      const { fetchPoiBundle } = await import("./poiLoader.ts");
      const { reportError } = await import("./errorReporter.ts");
      vi.mocked(reportError).mockClear();

      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));

      const result = await fetchPoiBundle("gdansk");
      expect(result).toBeNull();
      expect(reportError).toHaveBeenCalled();
    });
  });

  describe("loadPoiBundle", () => {
    it("fetches and syncs bundle", async () => {
      const { loadPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      mockFetchWith(makeBundle());
      const changed = await loadPoiBundle("gdansk");

      expect(changed).toBe(true);
      expect(await db.poiIndex.count()).toBe(2);
    });

    it("returns false when bundle not found", async () => {
      const { loadPoiBundle } = await import("./poiLoader.ts");
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 404 }),
      );

      const changed = await loadPoiBundle("unknown");
      expect(changed).toBe(false);
    });

    it("returns false when hash unchanged", async () => {
      const { loadPoiBundle } = await import("./poiLoader.ts");

      mockFetchWith(makeBundle());
      await loadPoiBundle("gdansk");

      mockFetchWith(makeBundle());
      const changed = await loadPoiBundle("gdansk");
      expect(changed).toBe(false);
    });

    it("does not load loose tier when strict bundle fails", async () => {
      const { loadPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose" },
        entries: [makeEntry("poi-l1", "School", { tier: "loose", source: "osm", rankBoost: 0.3 })],
      });

      mockFetchByUrl({
        "/poi/gdansk.br": null,
        "/poi/gdansk.loose.br": looseBundle,
      });

      const changed = await loadPoiBundle("gdansk", { includeLooseTier: true });
      expect(changed).toBe(false);
      expect(await db.poiIndex.count()).toBe(0);

      warnSpy.mockRestore();
    });

    it("loads both strict and loose tiers when includeLooseTier is true", async () => {
      const { loadPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      });
      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose", entryCount: 2 },
        entries: [
          makeEntry("poi-l1", "School A", { tier: "loose", source: "osm", rankBoost: 0.3 }),
          makeEntry("poi-l2", "Mall B", { tier: "loose", source: "osm", rankBoost: 0.3 }),
        ],
      });

      mockFetchByUrl({
        "/poi/gdansk.br": strictBundle,
        "/poi/gdansk.loose.br": looseBundle,
      });

      const changed = await loadPoiBundle("gdansk", { includeLooseTier: true });
      expect(changed).toBe(true);
      expect(await db.poiIndex.count()).toBe(3);

      const strictMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "strict"));
      expect(strictMeta?.activeBundleHash).toBe("strict-v1");

      const looseMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"));
      expect(looseMeta?.activeBundleHash).toBe("loose-v1");
    });

    it("retains the loose cache for category filtering when offline and all categories are hidden", async () => {
      const { loadPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");
      mockFetchByUrl({
        "/poi/gdansk.br": makeBundle({
          meta: { version: "strict-v1", tier: "strict" },
          entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
        }),
        "/poi/gdansk.loose.br": makeBundle({
          meta: { version: "loose-v1", tier: "loose" },
          entries: [makeEntry("poi-l1", "School A", { tier: "loose", category: "school" })],
        }),
      });
      await loadPoiBundle("gdansk", { includeLooseTier: true });
      const original = await db.poiIndex.toArray();
      const meta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"));
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
      await loadPoiBundle("gdansk", { includeLooseTier: false, retainLooseCache: true });
      expect(await db.poiIndex.toArray()).toEqual(original);
      expect(await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"))).toEqual(meta);
    });

    it("clears loose tier when includeLooseTier is false", async () => {
      const { loadPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      });
      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose" },
        entries: [makeEntry("poi-l1", "School A", { tier: "loose", source: "osm", rankBoost: 0.3 })],
      });

      mockFetchByUrl({
        "/poi/gdansk.br": strictBundle,
        "/poi/gdansk.loose.br": looseBundle,
      });

      await loadPoiBundle("gdansk", { includeLooseTier: true });
      expect(await db.poiIndex.count()).toBe(2);

      mockFetchByUrl({
        "/poi/gdansk.br": strictBundle,
      });

      await loadPoiBundle("gdansk", { includeLooseTier: false });
      expect(await db.poiIndex.count()).toBe(1);

      const remaining = await db.poiIndex.toArray();
      expect(remaining[0]!.tier).toBe("strict");

      const looseMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"));
      expect(looseMeta).toBeUndefined();
    });

    it("clears loose tier even when strict bundle fetch fails (offline opt-out)", async () => {
      const { loadPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      });
      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose" },
        entries: [makeEntry("poi-l1", "School A", { tier: "loose", source: "osm", rankBoost: 0.3 })],
      });

      mockFetchByUrl({
        "/poi/gdansk.br": strictBundle,
        "/poi/gdansk.loose.br": looseBundle,
      });

      await loadPoiBundle("gdansk", { includeLooseTier: true });
      expect(await db.poiIndex.count()).toBe(2);

      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));

      await loadPoiBundle("gdansk", { includeLooseTier: false });

      const remaining = await db.poiIndex.toArray();
      const looseRecords = remaining.filter((r) => r.tier === "loose");
      expect(looseRecords).toHaveLength(0);

      const looseMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"));
      expect(looseMeta).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("clears stale loose data when loose bundle returns 404", async () => {
      const { loadPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      });
      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose" },
        entries: [makeEntry("poi-l1", "School", { tier: "loose", source: "osm", rankBoost: 0.3 })],
      });

      mockFetchByUrl({
        "/poi/gdansk.br": strictBundle,
        "/poi/gdansk.loose.br": looseBundle,
      });
      await loadPoiBundle("gdansk", { includeLooseTier: true });
      expect(await db.poiIndex.count()).toBe(2);
      expect(await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"))).toBeDefined();

      mockFetchByUrl({
        "/poi/gdansk.br": strictBundle,
        "/poi/gdansk.loose.br": null,
      });
      await loadPoiBundle("gdansk", { includeLooseTier: true });

      expect(await db.poiIndex.count()).toBe(1);
      const remaining = await db.poiIndex.toArray();
      expect(remaining[0]!.tier).toBe("strict");
      expect(await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"))).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("stale call with includeLooseTier does not write loose data after newer call cleared it", async () => {
      const { loadPoiBundle, syncMetaKey } = await import("./poiLoader.ts");
      const { __resetPoiLoadStatusForTests } = await import("./poiLoader.ts");
      __resetPoiLoadStatusForTests();
      const { db } = await import("../db/index.ts");

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      });
      const looseBundle = makeBundle({
        meta: { version: "loose-v1", tier: "loose" },
        entries: [makeEntry("poi-l1", "School", { tier: "loose", source: "osm", rankBoost: 0.3 })],
      });

      resources.bodies.set("gdansk.br", new TextEncoder().encode(JSON.stringify(strictBundle)));
      let strictResolve: (v: Response) => void;
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          return new Promise<Response>((resolve) => { strictResolve = resolve; });
        }
        if (url.includes(".loose.")) {
          const encoded = new TextEncoder().encode(JSON.stringify(looseBundle));
          return Promise.resolve(new Response(encoded, { status: 200 }));
        }
        const encoded = new TextEncoder().encode(JSON.stringify(strictBundle));
        return Promise.resolve(new Response(encoded, { status: 200 }));
      });

      const staleCall = loadPoiBundle("gdansk", { includeLooseTier: true });
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

      const newerCall = loadPoiBundle("gdansk", { includeLooseTier: false });
      await newerCall;

      const encodedStrict = new TextEncoder().encode(JSON.stringify(strictBundle));
      strictResolve!(new Response(encodedStrict, { status: 200 }));
      await staleCall;

      const looseMeta = await db.poiSyncMeta.get(syncMetaKey("gdansk", "loose"));
      expect(looseMeta).toBeUndefined();

      const allRecords = await db.poiIndex.toArray();
      const looseTierRecords = allRecords.filter((r) => r.tier === "loose");
      expect(looseTierRecords).toHaveLength(0);
    });

    it("stale fetch error does not overwrite newer success status", async () => {
      const { loadPoiBundle, getPoiLoadErrors, __resetPoiLoadStatusForTests } =
        await import("./poiLoader.ts");
      __resetPoiLoadStatusForTests();

      const strictBundle = makeBundle({
        meta: { version: "strict-v1", tier: "strict" },
        entries: [makeEntry("poi-s1", "Station", { tier: "strict" })],
      });

      resources.bodies.set("gdansk.br", new TextEncoder().encode(JSON.stringify(strictBundle)));
      let staleResolve: (v: Response) => void;
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<Response>((resolve) => {
            staleResolve = resolve;
          });
        }
        const encoded = new TextEncoder().encode(JSON.stringify(strictBundle));
        return Promise.resolve(new Response(encoded, { status: 200 }));
      });

      const staleCall = loadPoiBundle("gdansk");
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
      const newerCall = loadPoiBundle("gdansk");
      await newerCall;

      expect(getPoiLoadErrors().has("gdansk:strict")).toBe(false);

      staleResolve!(new Response(null, { status: 500 }));
      await staleCall;

      expect(getPoiLoadErrors().has("gdansk:strict")).toBe(false);
    });

    it("cancels an invalidated bundle before it can write", async () => {
      const { cancelPoiBundleLoads, loadPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");
      let resolveFetch!: (response: Response) => void;
      let fetchSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      });

      const pending = loadPoiBundle("gdansk");
      await vi.waitFor(() => expect(fetchSignal).toBeDefined());
      cancelPoiBundleLoads();
      resolveFetch(new Response(
        new TextEncoder().encode(JSON.stringify(makeBundle())),
        { status: 200 },
      ));

      await expect(pending).resolves.toBe(false);
      expect(fetchSignal?.aborted).toBe(true);
      expect(await db.poiIndex.count()).toBe(0);
      expect(await db.poiSyncMeta.count()).toBe(0);
    });

    it("rolls back an IndexedDB write invalidated during the transaction", async () => {
      const { cancelPoiBundleLoads, loadPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");
      mockFetchWith(makeBundle());
      const bulkPut = db.poiIndex.bulkPut.bind(db.poiIndex);
      const bulkPutSpy = vi.spyOn(db.poiIndex, "bulkPut").mockImplementation((records) => {
        cancelPoiBundleLoads();
        return bulkPut(records);
      });

      try {
        await expect(loadPoiBundle("gdansk")).resolves.toBe(false);
        expect(await db.poiIndex.count()).toBe(0);
        expect(await db.poiSyncMeta.count()).toBe(0);
      } finally {
        bulkPutSpy.mockRestore();
      }
    });

    it("marks error with hasCachedFallback when cached data exists after fetch failure", async () => {
      const { syncPoiBundle, loadPoiBundle, getPoiLoadErrors, __resetPoiLoadStatusForTests } =
        await import("./poiLoader.ts");
      __resetPoiLoadStatusForTests();

      const bundle = makeBundle();
      await syncPoiBundle("gdansk", bundle);

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 500 }),
      );

      await loadPoiBundle("gdansk");

      const errors = getPoiLoadErrors();
      const error = errors.get("gdansk:strict");
      expect(error).toBeDefined();
      expect(error!.kind).toBe("fetch");
      expect(error!.hasCachedFallback).toBe(true);
    });

    it("marks quota error with hasCachedFallback when cached data exists after sync quota failure", async () => {
      const { syncPoiBundle, loadPoiBundle, getPoiLoadErrors, __resetPoiLoadStatusForTests } =
        await import("./poiLoader.ts");
      const { onQuotaNear } = await import("./storagePolicy.ts");
      const { db } = await import("../db/index.ts");
      __resetPoiLoadStatusForTests();

      const bundleV1 = makeBundle({
        meta: { version: "v1" },
        entries: [makeEntry("poi-1", "Station")],
      });
      await syncPoiBundle("gdansk", bundleV1);
      expect(await db.poiIndex.count()).toBe(1);

      const bundleV2 = makeBundle({
        meta: { version: "v2" },
        entries: [makeEntry("poi-2", "Ratusz")],
      });
      mockFetchWith(bundleV2);

      vi.spyOn(db.poiIndex, "bulkPut").mockRejectedValue(
        new DOMException("Storage quota exceeded", "QuotaExceededError"),
      );
      vi.mocked(onQuotaNear).mockResolvedValueOnce([]);

      await loadPoiBundle("gdansk");

      const errors = getPoiLoadErrors();
      const error = errors.get("gdansk:strict");
      expect(error).toBeDefined();
      expect(error!.kind).toBe("quota");
      expect(error!.hasCachedFallback).toBe(true);

      vi.mocked(db.poiIndex.bulkPut).mockRestore();
    });

    it("does not set hasCachedFallback on quota error when no cached data exists", async () => {
      const { loadPoiBundle, getPoiLoadErrors, __resetPoiLoadStatusForTests } =
        await import("./poiLoader.ts");
      const { onQuotaNear } = await import("./storagePolicy.ts");
      const { db } = await import("../db/index.ts");
      __resetPoiLoadStatusForTests();

      const bundle = makeBundle({
        meta: { version: "v1" },
        entries: [makeEntry("poi-1", "Station")],
      });
      mockFetchWith(bundle);

      vi.spyOn(db.poiIndex, "bulkPut").mockRejectedValue(
        new DOMException("Storage quota exceeded", "QuotaExceededError"),
      );
      vi.mocked(onQuotaNear).mockResolvedValueOnce([]);

      await loadPoiBundle("gdansk");

      const errors = getPoiLoadErrors();
      const error = errors.get("gdansk:strict");
      expect(error).toBeDefined();
      expect(error!.kind).toBe("quota");
      expect(error!.hasCachedFallback).toBeUndefined();

      vi.mocked(db.poiIndex.bulkPut).mockRestore();
    });

    it("does not set hasCachedFallback when no cached data exists", async () => {
      const { loadPoiBundle, getPoiLoadErrors, __resetPoiLoadStatusForTests } =
        await import("./poiLoader.ts");
      __resetPoiLoadStatusForTests();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 404 }),
      );

      await loadPoiBundle("new-city");

      const errors = getPoiLoadErrors();
      const error = errors.get("new-city:strict");
      expect(error).toBeDefined();
      expect(error!.kind).toBe("missing");
      expect(error!.hasCachedFallback).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("does not clear loose tier entries when no loose meta exists", async () => {
      const { loadPoiBundle } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      const strictBundle = makeBundle({
        meta: { version: "strict-v1" },
        entries: [makeEntry("poi-s1", "Station")],
      });
      mockFetchWith(strictBundle);

      await loadPoiBundle("gdansk");
      expect(await db.poiIndex.count()).toBe(1);
    });
  });

  describe("listenForSwUpdates", () => {
    it("registers controllerchange listener", async () => {
      const { listenForSwUpdates } = await import("./poiLoader.ts");

      const addEventListenerMock = vi.fn();
      Object.defineProperty(navigator, "serviceWorker", {
        value: { addEventListener: addEventListenerMock },
        configurable: true,
      });

      listenForSwUpdates(() => "gdansk");

      expect(addEventListenerMock).toHaveBeenCalledWith(
        "controllerchange",
        expect.any(Function),
      );
    });

    it("delegates controllerchange to mode-aware sync without fetching directly", async () => {
      const { listenForSwUpdates } = await import("./poiLoader.ts");
      const { db } = await import("../db/index.ts");

      let handler: (() => void) | undefined;
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          addEventListener: (_event: string, fn: () => void) => {
            handler = fn;
          },
        },
        configurable: true,
      });

      globalThis.fetch = vi.fn();
      const syncCurrentPoi = vi.fn(async () => {});
      listenForSwUpdates(() => "gdansk", () => true, syncCurrentPoi);

      handler!();
      await vi.waitFor(() => expect(syncCurrentPoi).toHaveBeenCalledTimes(1));

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(await db.poiIndex.count()).toBe(0);
    });

    it("skips load when no city is active", async () => {
      const { listenForSwUpdates } = await import("./poiLoader.ts");

      let handler: (() => void) | undefined;
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          addEventListener: (_event: string, fn: () => void) => {
            handler = fn;
          },
        },
        configurable: true,
      });

      globalThis.fetch = vi.fn();
      const syncCurrentPoi = vi.fn();
      listenForSwUpdates(() => null, undefined, syncCurrentPoi);

      handler!();
      await new Promise((r) => setTimeout(r, 50));

      expect(syncCurrentPoi).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("evictor registration", () => {
    it("registers poiIndex evictor with storage policy", async () => {
      const { registerEvictor } = await import("./storagePolicy.ts");
      await import("./poiLoader.ts");

      expect(registerEvictor).toHaveBeenCalledWith(
        "poiIndex",
        expect.any(Function),
      );
    });
  });

  describe("error paths", () => {
    beforeEach(async () => {
      const { __resetPoiLoadStatusForTests } = await import("./poiLoader.ts");
      __resetPoiLoadStatusForTests();
    });

    describe("bundle missing (404)", () => {
      it("logs warning and sets missing error on 404", async () => {
        const { fetchPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );

        const result = await fetchPoiBundle("unknown-city");

        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("POI bundle not found for unknown-city"),
        );

        const errors = getPoiLoadErrors();
        expect(errors.get("unknown-city:strict")).toMatchObject({
          kind: "missing",
          cityId: "unknown-city",
          tier: "strict",
        });

        warnSpy.mockRestore();
      });

      it("loadPoiBundle returns false gracefully when bundle missing", async () => {
        const { loadPoiBundle } = await import("./poiLoader.ts");
        const { db } = await import("../db/index.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );

        const changed = await loadPoiBundle("missing-city");

        expect(changed).toBe(false);
        expect(await db.poiIndex.count()).toBe(0);

        warnSpy.mockRestore();
      });

      it("logs warning on loose tier 404", async () => {
        const { fetchPoiBundle } = await import("./poiLoader.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );

        const result = await fetchPoiBundle("gdansk", "loose");

        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Loose POI bundle not found for gdansk"),
        );

        warnSpy.mockRestore();
      });

      it("notifies status listeners on missing bundle", async () => {
        const { fetchPoiBundle, onPoiLoadStatusChange } = await import("./poiLoader.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const listener = vi.fn();
        const unsub = onPoiLoadStatusChange(listener);

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );

        await fetchPoiBundle("gdansk");
        expect(listener).toHaveBeenCalledTimes(1);
        const errMap = listener.mock.calls[0]![0] as Map<string, unknown>;
        expect(errMap.has("gdansk:strict")).toBe(true);

        unsub();
        warnSpy.mockRestore();
      });
    });

    describe("brotli parse failure", () => {
      it("sets parse error and preserves cached copy on decompression failure", async () => {
        const { syncPoiBundle, fetchPoiBundle, getPoiLoadErrors } =
          await import("./poiLoader.ts");
        const { db } = await import("../db/index.ts");
        const { decompressBrotli } = await import("./brotliDecode.ts");

        const bundle = makeBundle();
        const encoded = new TextEncoder().encode(JSON.stringify(bundle));
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(encoded, { status: 200 }),
        );
        await syncPoiBundle("gdansk", bundle);
        expect(await db.poiIndex.count()).toBe(2);
        const metaBefore = await db.poiSyncMeta.get("gdansk");

        vi.mocked(decompressBrotli).mockRejectedValueOnce(
          new Error("Brotli decompression failed"),
        );
        resources.bodies.set("gdansk.br", new Uint8Array([0xff, 0xfe]));
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
        );

        const result = await fetchPoiBundle("gdansk");

        expect(result).toBeNull();
        const errors = getPoiLoadErrors();
        expect(errors.get("gdansk:strict")).toMatchObject({
          kind: "parse",
          cityId: "gdansk",
        });

        expect(await db.poiIndex.count()).toBe(2);
        const metaAfter = await db.poiSyncMeta.get("gdansk");
        expect(metaAfter?.activeBundleHash).toBe(metaBefore?.activeBundleHash);
      });

      it("sets parse error on invalid JSON", async () => {
        const { fetchPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const { decompressBrotli } = await import("./brotliDecode.ts");

        vi.mocked(decompressBrotli).mockResolvedValueOnce("not valid json {{{");
        const encoded = new TextEncoder().encode("garbage");
        resources.bodies.set("gdansk.br", encoded);
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(encoded, { status: 200 }),
        );

        const result = await fetchPoiBundle("gdansk");
        expect(result).toBeNull();

        const errors = getPoiLoadErrors();
        expect(errors.get("gdansk:strict")?.kind).toBe("parse");
      });

      it("reports error to errorReporter on parse failure", async () => {
        const { fetchPoiBundle } = await import("./poiLoader.ts");
        const { reportError } = await import("./errorReporter.ts");
        const { decompressBrotli } = await import("./brotliDecode.ts");
        vi.mocked(reportError).mockClear();

        vi.mocked(decompressBrotli).mockRejectedValueOnce(
          new Error("Brotli decompression failed"),
        );
        resources.bodies.set("gdansk.br", new Uint8Array([0xff]));
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(new Uint8Array([0xff]), { status: 200 }),
        );

        await fetchPoiBundle("gdansk");

        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Brotli decompression failed" }),
          expect.objectContaining({
            context: expect.objectContaining({ source: "poiLoader.decompress" }),
          }),
        );
      });
    });

    describe("quota exhaustion", () => {
      it("engages eviction on QuotaExceededError and retries", async () => {
        const { syncPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const { onQuotaNear } = await import("./storagePolicy.ts");
        const { db } = await import("../db/index.ts");

        const bundle = makeBundle({
          meta: { version: "quota-v1" },
          entries: [makeEntry("poi-q1", "Big Place")],
        });

        let callCount = 0;
        const origBulkPut = db.poiIndex.bulkPut.bind(db.poiIndex);
        vi.spyOn(db.poiIndex, "bulkPut").mockImplementation(((items: Parameters<typeof db.poiIndex.bulkPut>[0]) => {
          callCount++;
          if (callCount === 1) {
            throw new DOMException("Storage quota exceeded", "QuotaExceededError");
          }
          return origBulkPut(items);
        }) as typeof db.poiIndex.bulkPut);

        vi.mocked(onQuotaNear).mockResolvedValueOnce(["poiTileCache"]);

        const changed = await syncPoiBundle("gdansk", bundle);

        expect(changed).toBe(true);
        expect(onQuotaNear).toHaveBeenCalled();
        expect(await db.poiIndex.count()).toBe(1);

        const errors = getPoiLoadErrors();
        expect(errors.has("gdansk:strict")).toBe(false);

        vi.mocked(db.poiIndex.bulkPut).mockRestore();
      });

      it("sets quota error when eviction frees nothing", async () => {
        const { syncPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const { onQuotaNear } = await import("./storagePolicy.ts");
        const { reportError } = await import("./errorReporter.ts");
        vi.mocked(reportError).mockClear();

        const bundle = makeBundle({
          meta: { version: "quota-v2" },
          entries: [makeEntry("poi-q1", "Big Place")],
        });

        const { db } = await import("../db/index.ts");
        vi.spyOn(db.poiIndex, "bulkPut").mockRejectedValue(
          new DOMException("Storage quota exceeded", "QuotaExceededError"),
        );
        vi.mocked(onQuotaNear).mockResolvedValueOnce([]);

        const changed = await syncPoiBundle("gdansk", bundle);

        expect(changed).toBe(false);
        const errors = getPoiLoadErrors();
        expect(errors.get("gdansk:strict")).toMatchObject({
          kind: "quota",
          cityId: "gdansk",
        });
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("eviction freed nothing") }),
          expect.anything(),
        );

        vi.mocked(db.poiIndex.bulkPut).mockRestore();
      });

      it("sets quota error when retry also fails after eviction", async () => {
        const { syncPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const { onQuotaNear } = await import("./storagePolicy.ts");
        const { db } = await import("../db/index.ts");

        const bundle = makeBundle({
          meta: { version: "quota-v3" },
          entries: [makeEntry("poi-q1", "Big Place")],
        });

        vi.spyOn(db.poiIndex, "bulkPut").mockRejectedValue(
          new DOMException("Storage quota exceeded", "QuotaExceededError"),
        );
        vi.mocked(onQuotaNear).mockResolvedValueOnce(["poiTileCache"]);

        const changed = await syncPoiBundle("gdansk", bundle);

        expect(changed).toBe(false);
        const errors = getPoiLoadErrors();
        expect(errors.get("gdansk:strict")?.kind).toBe("quota");

        vi.mocked(db.poiIndex.bulkPut).mockRestore();
      });

      it("rethrows non-quota errors from Dexie write", async () => {
        const { syncPoiBundle } = await import("./poiLoader.ts");
        const { db } = await import("../db/index.ts");

        const bundle = makeBundle({
          meta: { version: "err-v1" },
          entries: [makeEntry("poi-e1", "Place")],
        });

        vi.spyOn(db.poiIndex, "bulkPut").mockRejectedValue(
          new Error("Some other Dexie error"),
        );

        await expect(syncPoiBundle("gdansk", bundle)).rejects.toThrow(
          "Some other Dexie error",
        );

        vi.mocked(db.poiIndex.bulkPut).mockRestore();
      });
    });

    describe("status lifecycle", () => {
      it("seeds new subscriber from existing errors (subscribe-after-error)", async () => {
        const { fetchPoiBundle, onPoiLoadStatusChange } = await import("./poiLoader.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );
        await fetchPoiBundle("gdansk");

        const listener = vi.fn();
        const unsub = onPoiLoadStatusChange(listener);

        expect(listener).toHaveBeenCalledTimes(1);
        const errMap = listener.mock.calls[0]![0] as Map<string, unknown>;
        expect(errMap.has("gdansk:strict")).toBe(true);

        unsub();
        warnSpy.mockRestore();
      });

      it("clears error on successful fetch after previous failure", async () => {
        const { fetchPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );
        await fetchPoiBundle("gdansk");
        expect(getPoiLoadErrors().has("gdansk:strict")).toBe(true);

        const bundle = makeBundle();
        mockFetchWith(bundle);
        const result = await fetchPoiBundle("gdansk");
        expect(result).not.toBeNull();
        expect(getPoiLoadErrors().has("gdansk:strict")).toBe(false);

        warnSpy.mockRestore();
      });

      it("unsubscribe stops listener notifications", async () => {
        const { fetchPoiBundle, onPoiLoadStatusChange } = await import("./poiLoader.ts");
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const listener = vi.fn();
        const unsub = onPoiLoadStatusChange(listener);
        unsub();

        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(null, { status: 404 }),
        );
        await fetchPoiBundle("gdansk");
        expect(listener).not.toHaveBeenCalled();

        warnSpy.mockRestore();
      });

      it("clears quota error on successful sync after eviction", async () => {
        const { syncPoiBundle, getPoiLoadErrors } = await import("./poiLoader.ts");
        const { onQuotaNear } = await import("./storagePolicy.ts");
        const { db } = await import("../db/index.ts");

        const bundle1 = makeBundle({
          meta: { version: "q-v1" },
          entries: [makeEntry("poi-1", "A")],
        });

        vi.spyOn(db.poiIndex, "bulkPut").mockRejectedValue(
          new DOMException("quota", "QuotaExceededError"),
        );
        vi.mocked(onQuotaNear).mockResolvedValueOnce([]);

        await syncPoiBundle("gdansk", bundle1);
        expect(getPoiLoadErrors().get("gdansk:strict")?.kind).toBe("quota");

        vi.mocked(db.poiIndex.bulkPut).mockRestore();

        const bundle2 = makeBundle({
          meta: { version: "q-v2" },
          entries: [makeEntry("poi-2", "B")],
        });
        await syncPoiBundle("gdansk", bundle2);
        expect(getPoiLoadErrors().has("gdansk:strict")).toBe(false);
      });
    });
  });
});
