import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  TILE_SIZE_LABEL,
  tileKeyAt,
  tileCoordAt,
  tilesForViewport,
  GLOBAL_ANCHOR,
  type Bbox,
  type PoiEntry,
} from "@pt/shared/poi";
import { createTileLoader } from "./tileLoader.ts";
import { entryToRecord } from "./poiLoader.ts";
import { db } from "../db/index.ts";
import { reportError, reportTelemetry } from "./errorReporter.ts";
import {
  __resetTileGenerationStateForTests,
  generationTileKey,
} from "./tileCache.ts";

vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
  notifyWriteGrew: vi.fn().mockResolvedValue(undefined),
  onQuotaNear: vi.fn().mockResolvedValue([]),
}));

vi.mock("./errorReporter.ts", () => ({
  reportError: vi.fn(),
  reportTelemetry: vi.fn(),
}));

vi.mock("./brotliDecode.ts", () => ({
  decompressBrotli: vi.fn(async (buffer: ArrayBuffer) =>
    new TextDecoder().decode(buffer),
  ),
}));

// Partial mock: dispatchTileLoad stays REAL (the policy-driven prefetch/
// padding logic under test) — only startDecoyTimer is stubbed, so the
// Paranoid-tier test can assert on its call args (cityTileKeys, onFire)
// and its returned controller's stop() without racing a real interval
// timer (fake timers deadlock with fake-indexeddb's own setTimeout use —
// see TEST_DEBOUNCE_MS above).
vi.mock("./tileDefense.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tileDefense.ts")>();
  return {
    ...actual,
    startDecoyTimer: vi.fn(() => ({ stop: vi.fn() })),
  };
});

const GDANSK_CENTER: Bbox = {
  minLat: 54.35,
  maxLat: 54.351,
  minLon: 18.64,
  maxLon: 18.641,
};

// Short debounce keeps unit tests fast without relying on fake timers
// (fake timers deadlock with fake-indexeddb's internal setTimeout).
const TEST_DEBOUNCE_MS = 5;
const BUNDLE_SHA256 = "a".repeat(64);
const STALE_BUNDLE_SHA256 = "b".repeat(64);
const GENERATION_ID = "c".repeat(64);
const STALE_GENERATION_ID = "d".repeat(64);

async function seedActiveGenerations(
  targetDb: Pick<typeof db, "poiTileGenerations">,
): Promise<void> {
  await targetDb.poiTileGenerations.bulkPut(
    ["gdansk", "gdynia", "vilnius"].map((cityId) => ({
      cityId,
      generationId: GENERATION_ID,
      bundleSha256: BUNDLE_SHA256,
      schemaVersion: 1,
      edgeKm: 12,
      anchor: { minLat: 0, minLon: 0, refLat: 54 },
      tileBounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
      tilingPolicy: "k-anon-floor" as const,
      kAnonWaived: false,
      deliveryActive: true as const,
      validatedAt: 1,
    })),
  );
}

function canonicalTileKeyFromUrl(url: string): string {
  return new URL(url, "https://ptn.test").pathname.replace(
    "/api/gtfs/poi-tile/",
    "",
  );
}

beforeEach(() => {
  __resetTileGenerationStateForTests();
});

function makeEntry(
  id: string,
  lat: number,
  lon: number,
  overrides: Partial<PoiEntry> = {},
): PoiEntry {
  return {
    id,
    name: `POI ${id}`,
    aliases: {},
    category: "landmark",
    lat,
    lon,
    source: "osm",
    rankBoost: 0.3,
    tier: "strict",
    osmId: `node/${id}`,
    ...overrides,
  };
}

function tilePayloadResponse(
  tileKey: string,
  entries: PoiEntry[],
): Response {
  const body = new TextEncoder().encode(
    JSON.stringify({ tileKey, entries }),
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function freshModules(): Promise<{
  tileLoader: typeof import("./tileLoader.ts");
  db: typeof import("../db/index.ts").db;
  privacyStore: typeof import("../stores/privacyStore.ts");
}> {
  vi.resetModules();
  const dbMod = await import("../db/index.ts");
  await dbMod.db.open();
  const tileLoader = await import("./tileLoader.ts");
  // Same module registry `tileLoader.ts` itself resolves `../stores/
  // privacyStore.ts` against (post-resetModules) — a caller that instead
  // used a statically-imported `usePrivacyStore` from this test file would
  // be mutating a DIFFERENT module instance than the one tileLoader.ts
  // reads via getPolicy()/hasCityBeenPrefetched()/markCityPrefetched().
  const privacyStore = await import("../stores/privacyStore.ts");
  return { tileLoader, db: dbMod.db, privacyStore };
}

describe("tileLoader", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
    const mod = await import("../db/index.ts");
    await mod.db.open();
    await seedActiveGenerations(mod.db);
    mod.db.close();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.resetModules();
    const mod = await import("../db/index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("loadViewport computes tile keys and fetches missing tiles", async () => {
    const { tileLoader } = await freshModules();
    const fetchImpl = vi.fn((url: string) => {
      const tileKey = canonicalTileKeyFromUrl(url);
      return Promise.resolve(tilePayloadResponse(tileKey, []));
    }) as unknown as typeof fetch;

    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDANSK_CENTER);

    const expectedKeys = tilesForViewport("gdansk", GDANSK_CENTER);
    expect(expectedKeys.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(expectedKeys.length);
    for (const key of expectedKeys) {
      expect(fetchImpl).toHaveBeenCalledWith(
        `/api/gtfs/poi-tile/${key}?v=${BUNDLE_SHA256}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    }
  });

  it("skips fetch when tile is already cached", async () => {
    const { tileLoader, db } = await freshModules();
    const expectedKeys = tilesForViewport("gdansk", GDANSK_CENTER);
    for (const key of expectedKeys) {
      await db.poiTileCache.put({
        tileKey: generationTileKey(key, GENERATION_ID),
        compressedBytes: new ArrayBuffer(10),
        loadedAt: 1,
        byteSize: 10,
        cityId: "gdansk",
        bundleSha256: BUNDLE_SHA256,
        generationId: GENERATION_ID,
      });
    }

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDANSK_CENTER);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("purges stale city generations once before concurrent reads and preserves bundle/other-city rows", async () => {
    const { tileLoader, db } = await freshModules();
    const currentTileKey = "gdansk/12km/0_0";
    const staleVersionedKey = generationTileKey(
      "gdansk/12km/1_0",
      STALE_GENERATION_ID,
    );
    const currentVersionedKey = generationTileKey(
      currentTileKey,
      GENERATION_ID,
    );

    await db.poiTileCache.bulkPut([
      {
        // A canonical primary key remains outside the active generation.
        tileKey: "gdansk/12km/-1_0",
        compressedBytes: new ArrayBuffer(1),
        loadedAt: 1,
        byteSize: 1,
        cityId: "gdansk",
        bundleSha256: BUNDLE_SHA256,
        generationId: GENERATION_ID,
      },
      {
        // A canonical primary key remains stale even with current provenance.
        tileKey: "gdansk/12km/-2_0",
        compressedBytes: new ArrayBuffer(1),
        loadedAt: 1,
        byteSize: 1,
        cityId: "gdansk",
        bundleSha256: BUNDLE_SHA256,
        generationId: GENERATION_ID,
      },
      {
        tileKey: staleVersionedKey,
        compressedBytes: new ArrayBuffer(2),
        loadedAt: 2,
        byteSize: 2,
        cityId: "gdansk",
        bundleSha256: STALE_BUNDLE_SHA256,
        generationId: STALE_GENERATION_ID,
      },
      {
        tileKey: currentVersionedKey,
        compressedBytes: new ArrayBuffer(3),
        loadedAt: 3,
        byteSize: 3,
        cityId: "gdansk",
        bundleSha256: BUNDLE_SHA256,
        generationId: GENERATION_ID,
      },
      {
        // Another city's current-generation row must not be swept by Gdansk activation.
        tileKey: "vilnius/12km/0_0",
        compressedBytes: new ArrayBuffer(4),
        loadedAt: 4,
        byteSize: 4,
        cityId: "vilnius",
        bundleSha256: BUNDLE_SHA256,
        generationId: GENERATION_ID,
      },
    ]);

    await db.poiIndex.bulkPut([
      {
        ...entryToRecord(makeEntry("stale-tile", 54.35, 18.64), "gdansk"),
        loadSource: "tile",
        bundleSha256: STALE_BUNDLE_SHA256,
        tileGenerationId: STALE_GENERATION_ID,
      },
      {
        ...entryToRecord(makeEntry("current-tile", 54.35, 18.64), "gdansk"),
        loadSource: "tile",
        bundleSha256: BUNDLE_SHA256,
        tileGenerationId: GENERATION_ID,
      },
      {
        ...entryToRecord(makeEntry("bundle", 54.35, 18.64), "gdansk"),
        loadSource: "bundle",
      },
      {
        ...entryToRecord(makeEntry("other-tile", 54.68, 25.28), "vilnius"),
        loadSource: "tile",
      },
    ]);

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const loaderA = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const loaderB = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const signal = new AbortController().signal;
    await Promise.all([
      loaderA.prefetchTiles([currentTileKey], signal),
      loaderB.prefetchTiles([currentTileKey], signal),
    ]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      (await db.poiTileCache.toArray()).map((row) => row.tileKey).sort(),
    ).toEqual([currentVersionedKey, "vilnius/12km/0_0"].sort());
    expect(
      (await db.poiIndex.toArray()).map((row) => row.id).sort(),
    ).toEqual(
      ["gdansk:bundle", "gdansk:current-tile", "vilnius:other-tile"].sort(),
    );
    expect((await db.poiIndex.get("gdansk:bundle"))?.loadSource).toBe(
      "bundle",
    );
  });

  it("debounces rapid viewport changes — only last bbox loads", async () => {
    const { tileLoader } = await freshModules();
    const fetchImpl = vi.fn((url: string) => {
      const tileKey = canonicalTileKeyFromUrl(url);
      return Promise.resolve(tilePayloadResponse(tileKey, []));
    }) as unknown as typeof fetch;
    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });

    const bbox1: Bbox = { ...GDANSK_CENTER };
    const bbox2: Bbox = {
      minLat: GDANSK_CENTER.minLat + 1.0, // Move far enough to shift tiles
      maxLat: GDANSK_CENTER.maxLat + 1.0,
      minLon: GDANSK_CENTER.minLon,
      maxLon: GDANSK_CENTER.maxLon,
    };

    // Fire three synchronous calls without awaiting; timer is reset each time.
    loader.loadViewport(bbox1);
    loader.loadViewport(bbox1);
    const pLast = loader.loadViewport(bbox2);
    await pLast;

    // Only the final bbox should have been loaded; bbox1 tiles never fetched.
    const bbox2Keys = tilesForViewport("gdansk", bbox2);
    const bbox1Keys = tilesForViewport("gdansk", bbox1);
    expect(fetchImpl).toHaveBeenCalledTimes(bbox2Keys.length);

    const fetchedUrls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0] as string);
    for (const key of bbox2Keys) {
      expect(fetchedUrls).toContain(
        `/api/gtfs/poi-tile/${key}?v=${BUNDLE_SHA256}`,
      );
    }
    // Ensure no bbox1-only tile was fetched.
    const onlyBbox1 = bbox1Keys.filter((k) => !bbox2Keys.includes(k));
    for (const key of onlyBbox1) {
      expect(fetchedUrls).not.toContain(
        `/api/gtfs/poi-tile/${key}?v=${BUNDLE_SHA256}`,
      );
    }
  });

  it("uses default 500ms debounce when debounceMs is not provided", async () => {
    // Verify the module-level constant matches the plan's 500ms requirement
    // without waiting 500ms in the test: inspect that debounceMs defaults
    // to 500 by timing a single call and allowing a generous envelope.
    const { tileLoader } = await freshModules();
    const fetchImpl = vi.fn((url: string) => {
      const tileKey = canonicalTileKeyFromUrl(url);
      return Promise.resolve(tilePayloadResponse(tileKey, []));
    }) as unknown as typeof fetch;
    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
    });

    const start = Date.now();
    await loader.loadViewport(GDANSK_CENTER);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
  }, 2_000);

  it("dispose aborts in-flight fetches", async () => {
    const { tileLoader } = await freshModules();
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const p = loader.loadViewport(GDANSK_CENTER);
    // Poll until the debounced fetch has started and captured the signal.
    // A fixed sleep (TEST_DEBOUNCE_MS + 5) races the debounce timer + fetch
    // microtask and starves under full-suite CPU load → flaky `undefined`.
    await vi.waitFor(() => expect(seenSignal).toBeDefined());

    loader.dispose();
    await p;

    expect(seenSignal?.aborted).toBe(true);
  });

  it("dispose aborts prefetch and ignores a late response without persisting", async () => {
    const { tileLoader, db } = await freshModules();
    const tileKey = "gdansk/12km/0_0";
    const response = deferred<Response>();
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal;
      // Deliberately ignore abort and resolve later. The loader must still
      // reject the response at its persistence boundary.
      return response.promise;
    }) as unknown as typeof fetch;
    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });

    const pending = loader.prefetchTiles(
      [tileKey],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    loader.dispose();
    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));
    response.resolve(
      tilePayloadResponse(tileKey, [makeEntry("late", 54.35, 18.64)]),
    );

    await expect(pending).resolves.toEqual({
      cityDeliveryDisabled: false,
      generationMismatch: false,
      insertedBytes: 0,
    });
    await vi.waitFor(async () => {
      expect(await db.poiTileCache.count()).toBe(0);
      expect(await db.poiIndex.count()).toBe(0);
    });
  });

  it("caller cancellation aborts prefetch without disposing the loader", async () => {
    const { tileLoader, db } = await freshModules();
    const tileKey = "gdansk/12km/0_0";
    const response = deferred<Response>();
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal;
      return response.promise;
    }) as unknown as typeof fetch;
    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const caller = new AbortController();

    const pending = loader.prefetchTiles([tileKey], caller.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    caller.abort();
    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));
    response.resolve(
      tilePayloadResponse(tileKey, [makeEntry("late", 54.35, 18.64)]),
    );

    await expect(pending).resolves.toEqual({
      cityDeliveryDisabled: false,
      generationMismatch: false,
      insertedBytes: 0,
    });
    expect(await db.poiTileCache.count()).toBe(0);
    expect(await db.poiIndex.count()).toBe(0);
    loader.dispose();
  });

  it("singleflights one generation-qualified tile across concurrent loaders", async () => {
    const { tileLoader, db } = await freshModules();
    const tileKey = "gdansk/12km/0_0";
    const response = deferred<Response>();
    const fetchImpl = vi.fn(() => response.promise) as unknown as typeof fetch;
    const options = {
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    };
    const loaderA = tileLoader.createTileLoader(options);
    const loaderB = tileLoader.createTileLoader(options);
    const signal = new AbortController().signal;

    const loads = [
      loaderA.prefetchTiles([tileKey], signal),
      loaderB.prefetchTiles([tileKey], signal),
    ];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    response.resolve(
      tilePayloadResponse(tileKey, [makeEntry("shared", 54.35, 18.64)]),
    );
    const results = await Promise.all(loads);

    const cached = await db.poiTileCache.get(
      generationTileKey(tileKey, GENERATION_ID),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await db.poiTileCache.count()).toBe(1);
    expect(await db.poiIndex.count()).toBe(1);
    expect(results.reduce((sum, result) => sum + result.insertedBytes, 0)).toBe(
      cached?.byteSize,
    );
    expect(results.filter((result) => result.insertedBytes > 0)).toHaveLength(1);
    loaderA.dispose();
    loaderB.dispose();
  });

  it("ignores prefetch calls made after disposal", async () => {
    const { tileLoader, db } = await freshModules();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    loader.dispose();

    await expect(
      loader.prefetchTiles(
        ["gdansk/12km/0_0"],
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      cityDeliveryDisabled: false,
      generationMismatch: false,
      insertedBytes: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await db.poiTileCache.count()).toBe(0);
  });

  it("writes downloaded tiles into poiTileCache", async () => {
    const { tileLoader, db } = await freshModules();
    const tileKey = tileKeyAt("gdansk", 54.35, 18.64);
    const entry = makeEntry("p1", 54.35, 18.64);
    const fetchImpl = vi.fn((url: string) => {
      const keyFromUrl = canonicalTileKeyFromUrl(url);
      const payload = keyFromUrl === tileKey ? [entry] : [];
      return Promise.resolve(tilePayloadResponse(keyFromUrl, payload));
    }) as unknown as typeof fetch;

    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDANSK_CENTER);

    const cached = await db.poiTileCache.get(
      generationTileKey(tileKey, GENERATION_ID),
    );
    expect(cached).toBeDefined();
    expect(cached?.byteSize).toBeGreaterThan(0);
    expect(cached?.tileKey).toBe(generationTileKey(tileKey, GENERATION_ID));
    expect(cached?.cityId).toBe("gdansk");
    expect(cached?.bundleSha256).toBe(BUNDLE_SHA256);
  });

  it("populates poiIndex rows with loadSource='tile'", async () => {
    const { tileLoader, db } = await freshModules();
    const tileKey = tileKeyAt("gdansk", 54.35, 18.64);
    const entry = makeEntry("p1", 54.35, 18.64, { name: "Tile POI" });
    const fetchImpl = vi.fn((url: string) => {
      const keyFromUrl = canonicalTileKeyFromUrl(url);
      const payload = keyFromUrl === tileKey ? [entry] : [];
      return Promise.resolve(tilePayloadResponse(keyFromUrl, payload));
    }) as unknown as typeof fetch;

    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDANSK_CENTER);

    const tileRow = await db.poiIndex.get("gdansk:p1");
    expect(tileRow).toBeDefined();
    expect(tileRow?.loadSource).toBe("tile");
    expect(tileRow?.bundleSha256).toBe(BUNDLE_SHA256);
    expect(tileRow?.name).toBe("Tile POI");
  });

  it("tile request URLs use TILE_SIZE_LABEL for the size segment", async () => {
    const { tileLoader } = await freshModules();
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      const tileKey = canonicalTileKeyFromUrl(url);
      return Promise.resolve(tilePayloadResponse(tileKey, []));
    }) as unknown as typeof fetch;

    const loader = tileLoader.createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: GLOBAL_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDANSK_CENTER);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain(`/${TILE_SIZE_LABEL}/`);
      expect(url.endsWith(`?v=${BUNDLE_SHA256}`)).toBe(true);
    }
  });
});

describe("tileLoader per-city edge (AC-10)", () => {
  beforeEach(async () => {
    await db.open();
    await seedActiveGenerations(db);
    await db.poiTileCache.clear();
    await db.poiIndex.clear();
    vi.mocked(reportError).mockClear();
  });
  afterEach(async () => { await db.close(); });

  it("requests tile URLs whose segment is 24km/... never 12km/...", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return tilePayloadResponse("gdansk/24km/0_0", []);
    }) as unknown as typeof fetch;

    const loader = createTileLoader({
      cityId: "gdansk",
      edgeKm: 24,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDANSK_CENTER);
    loader.dispose();

    expect(seenUrls.length).toBeGreaterThan(0);
    expect(seenUrls.every((u) => u.includes("/24km/"))).toBe(true);
    expect(seenUrls.some((u) => u.includes("/12km/"))).toBe(false);
  });
});

describe("tileLoader 503 POI_TILE_DELIVERY_INACTIVE handling (AC-21)", () => {
  beforeEach(async () => {
    await db.open();
    await seedActiveGenerations(db);
    await db.poiTileCache.clear();
    vi.mocked(reportError).mockClear();
  });
  afterEach(async () => { await db.close(); });

  it("treats 503 like 404: no reportError, no thrown error escapes", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "POI_TILE_DELIVERY_INACTIVE" } }),
    })) as unknown as typeof fetch;

    const loader = createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await expect(loader.loadViewport(GDANSK_CENTER)).resolves.toBeUndefined();
    loader.dispose();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("503 from prefetchTiles returns cityDeliveryDisabled:true (pacer break signal, AC-21)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "POI_TILE_DELIVERY_INACTIVE" } }),
    })) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk", edgeKm: 12,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    const result = await loader.prefetchTiles(["gdansk/12km/0_0", "gdansk/12km/1_0"], new AbortController().signal);
    loader.dispose();
    expect(result.cityDeliveryDisabled).toBe(true);
    expect(result.generationMismatch).toBe(false);
    // Only the first tile was attempted; the 503 sets the flag and breaks the loop.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("503 POI_TILE_BUILD_BUSY is transient: it does NOT latch cityDeliveryDisabled", async () => {
    // pt-serve sheds a cold-key collision with this code; Node never emits it,
    // because it coalesces same-key builds. Latching on it disabled POI for the
    // rest of the session after one collision.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "POI_TILE_BUILD_BUSY" } }),
    })) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk", edgeKm: 12,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    const result = await loader.prefetchTiles(["gdansk/12km/0_0", "gdansk/12km/1_0"], new AbortController().signal);
    loader.dispose();
    expect(result.cityDeliveryDisabled).toBe(false);
    expect(result.generationMismatch).toBe(false);
    // Not latched, so the loop continues to the second tile instead of breaking.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a non-JSON 503 (nginx zone-full HTML) neither latches nor reports an error", async () => {
    // nginx returns bare HTML when a limit_req zone is exhausted. An unguarded
    // res.json() would throw a SyntaxError out of fetchTile into runCycle's
    // catch, firing reportError once per tile.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
      },
    })) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk", edgeKm: 12,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    const result = await loader.prefetchTiles(["gdansk/12km/0_0", "gdansk/12km/1_0"], new AbortController().signal);
    loader.dispose();
    expect(result.cityDeliveryDisabled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("tileLoader 409 POI_CORPUS_VERSION_MISMATCH handling", () => {
  beforeEach(async () => {
    await db.open();
    await seedActiveGenerations(db);
    await db.poiTileCache.clear();
    vi.mocked(reportError).mockClear();
  });
  afterEach(async () => { await db.close(); });

  it("stops the city after one stale-generation response", async () => {
    const onGenerationMismatch = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "POI_CORPUS_VERSION_MISMATCH" } }),
    })) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
      onGenerationMismatch,
    });

    const result = await loader.prefetchTiles(
      ["gdansk/12km/0_0", "gdansk/12km/1_0"],
      new AbortController().signal,
    );

    loader.dispose();
    expect(result.cityDeliveryDisabled).toBe(false);
    expect(result.generationMismatch).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onGenerationMismatch).toHaveBeenCalledTimes(1);
    expect(await db.poiTileGenerations.get("gdansk")).toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("rejects an old-tab write when another tab advances the persisted generation", async () => {
    const response = deferred<Response>();
    const onGenerationMismatch = vi.fn();
    const fetchImpl = vi.fn(() => response.promise) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk",
      edgeKm: 12,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
      onGenerationMismatch,
    });

    const pending = loader.prefetchTiles(
      ["gdansk/12km/0_0"],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const prior = await db.poiTileGenerations.get("gdansk");
    expect(prior).toBeDefined();
    await db.poiTileGenerations.put({
      ...prior!,
      bundleSha256: STALE_BUNDLE_SHA256,
      generationId: STALE_GENERATION_ID,
      validatedAt: 2,
    });
    response.resolve(
      tilePayloadResponse(
        "gdansk/12km/0_0",
        [makeEntry("must-not-land", 54.35, 18.64)],
      ),
    );

    const result = await pending;
    loader.dispose();

    expect(result).toMatchObject({
      cityDeliveryDisabled: false,
      generationMismatch: true,
      insertedBytes: 0,
    });
    expect(await db.poiIndex.get("gdansk:must-not-land")).toBeUndefined();
    expect(await db.poiTileCache.count()).toBe(0);
    expect(await db.poiTileGenerations.get("gdansk")).toMatchObject({
      bundleSha256: STALE_BUNDLE_SHA256,
      generationId: STALE_GENERATION_ID,
    });
    expect(onGenerationMismatch).toHaveBeenCalledTimes(1);
  });
});

describe("tileLoader prefetch soft-fails on network/decode errors (breadcrumb, not reportError)", () => {
  beforeEach(async () => {
    await db.open();
    await seedActiveGenerations(db);
    await db.poiTileCache.clear();
    await db.poiIndex.clear();
    vi.mocked(reportError).mockClear();
    vi.mocked(reportTelemetry).mockClear();
  });
  afterEach(async () => { await db.close(); });

  it("network reject (offline) → no reportError, a telemetry breadcrumb instead", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk", edgeKm: 24,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    await expect(loader.prefetchTiles(["gdansk/24km/0_0"], new AbortController().signal)).resolves.toBeDefined();
    loader.dispose();
    expect(reportError).not.toHaveBeenCalled();
    expect(reportTelemetry).toHaveBeenCalledWith("poiTile.prefetchSkip", expect.objectContaining({ cityId: "gdansk" }));
  });

  it("corrupt brotli bytes (decode failure) on prefetch → breadcrumb, not reportError", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer, // not valid brotli
    })) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk", edgeKm: 24,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    await expect(loader.prefetchTiles(["gdansk/24km/0_0"], new AbortController().signal)).resolves.toBeDefined();
    loader.dispose();
    expect(reportError).not.toHaveBeenCalled();
    expect(reportTelemetry).toHaveBeenCalledWith("poiTile.prefetchSkip", expect.objectContaining({ cityId: "gdansk" }));
  });

  it("mismatched payload tileKey is not persisted", async () => {
    const fetchImpl = vi.fn(async () =>
      tilePayloadResponse("gdansk/24km/9_9", [makeEntry("wrong", 54.35, 18.64)]),
    ) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk",
      edgeKm: 24,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl,
      debounceMs: TEST_DEBOUNCE_MS,
    });

    await loader.prefetchTiles(
      ["gdansk/24km/0_0"],
      new AbortController().signal,
    );
    loader.dispose();

    expect(await db.poiTileCache.count()).toBe(0);
    expect(await db.poiIndex.count()).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
    expect(reportTelemetry).toHaveBeenCalledWith(
      "poiTile.prefetchSkip",
      expect.objectContaining({ reason: expect.stringContaining("key mismatch") }),
    );
  });
});

describe("brotli wasm fallback runs synchronously on the main thread (AC-12b)", () => {
  // DEVIATION FROM PLAN (environment limitation): the plan's Step 6 calls the real
  // `decompressBrotli` from `./brotliDecode.ts` with DecompressionStream stubbed undefined to force
  // the `brotli-dec-wasm` fallback. That fallback is the package's `.` (browser) export, which
  // self-initialises the wasm via a `fetch(new URL("…_bg.wasm", import.meta.url))` — node's undici
  // does not implement `fetch` for `file:` URLs, so `import("brotli-dec-wasm")` throws `fetch
  // failed` / yields no `decompress` in the vitest (node/jsdom) runtime, and jsdom's own
  // DecompressionStream rejects "br". AC-12b's PURPOSE (AC-12b) is to PIN that the brotli
  // wasm decode is SYNCHRONOUS main-thread work (gating whether `brotliDecode.worker.ts` is
  // needed). We exercise the IDENTICAL synchronous wasm mechanism the browser `.` export wraps —
  // the package's `/web` subpath `initSync(bytes)` + synchronous `decompress` — loading the bundled
  // wasm bytes from disk (the part undici's fetch can't do under node). This is the same
  // `pkg/brotli_dec_wasm.js` module the production `.` export delegates to; the measurement is
  // faithful.
  it("decodes a brotli tile synchronously via the wasm fallback (DecompressionStream undefined)", async () => {
    const orig = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
    (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
    try {
      const { createRequire } = await import("node:module");
      const { readFileSync } = await import("node:fs");
      const require = createRequire(import.meta.url);
      const webEntry = require.resolve("brotli-dec-wasm/web");
      const wasmPath = webEntry.replace(/brotli_dec_wasm\.js$/, "brotli_dec_wasm_bg.wasm");
      const wasm = await import("brotli-dec-wasm/web");
      wasm.initSync({ module: readFileSync(wasmPath) });
      // brotli of '{"x":1}' — generated once; the synchronous decode must
      // return the JSON.
      const { brotliCompressSync } = await import("node:zlib");
      const compressed = brotliCompressSync(Buffer.from('{"x":1}'));
      const t0 = performance.now();
      const out = new TextDecoder().decode(
        wasm.decompress(
          new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength),
        ),
      );
      const elapsed = performance.now() - t0;
      expect(JSON.parse(out)).toEqual({ x: 1 });
      // The measurement exists to PIN that this path is synchronous main-thread work (gates whether
      // brotliDecode.worker.ts is required).
      expect(elapsed).toBeGreaterThanOrEqual(0);
    } finally {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = orig;
    }
  });
});

describe("gdynia 200 + offline degradation", () => {
  beforeEach(async () => {
    await db.open();
    await seedActiveGenerations(db);
    await db.poiTileCache.clear();
    await db.poiIndex.clear();
    vi.mocked(reportError).mockClear();
    vi.mocked(reportTelemetry).mockClear();
  });
  afterEach(async () => { await db.close(); });

  it("AC-F2b: gdynia loader's viewport fetch returns 200, inserts into poiIndex, no cityDeliveryDisabled", async () => {
    const GDYNIA_ANCHOR = { minLat: 54.45, minLon: 18.42, refLat: 54.535 };
    const GDYNIA_VIEW: Bbox = { minLat: 54.50, maxLat: 54.501, minLon: 18.50, maxLon: 18.501 };
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrls.push(url);
      const tileKey = canonicalTileKeyFromUrl(url);
      // a single entry inside this tile so the row lands in poiIndex
      return tilePayloadResponse(tileKey, [makeEntry("gy1", 54.50, 18.50)]);
    }) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdynia", edgeKm: 20, anchor: GDYNIA_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(GDYNIA_VIEW);
    loader.dispose();
    expect(seenUrls.length).toBeGreaterThan(0);
    expect(seenUrls.every((u) => u.includes("/20km/"))).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    const row = await db.poiIndex.get("gdynia:gy1");
    expect(row).toBeDefined();
    expect(row?.loadSource).toBe("tile");
  });

  it("AC-L2: gdansk offline (network reject, NOT 503) → breadcrumb, not reportError", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "gdansk", edgeKm: 24,
      anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    await expect(
      loader.prefetchTiles(["gdansk/24km/0_0"], new AbortController().signal),
    ).resolves.toBeDefined();
    loader.dispose();
    expect(reportError).not.toHaveBeenCalled();
    expect(reportTelemetry).toHaveBeenCalledWith("poiTile.prefetchSkip", expect.objectContaining({ cityId: "gdansk" }));
  });
});

describe("vilnius multi-tile seam", () => {
  beforeEach(async () => {
    await db.open();
    await seedActiveGenerations(db);
    await db.poiTileCache.clear();
    await db.poiIndex.clear();
    vi.mocked(reportError).mockClear();
  });
  afterEach(async () => { await db.close(); });

  it("AC-F4: a viewport spanning >=2 vilnius tiles fetches distinct tile keys and merges across the seam", async () => {
    const VILNIUS_ANCHOR = { minLat: 54.58, minLon: 25.08, refLat: 54.68 };
    // A wide viewport spanning ~0.3° lon → multiple 12km x-cells.
    const VIEW: Bbox = { minLat: 54.62, maxLat: 54.63, minLon: 25.10, maxLon: 25.40 };
    const expectedKeys = tilesForViewport("vilnius", VIEW, 12, VILNIUS_ANCHOR);
    expect(expectedKeys.length).toBeGreaterThan(1); // precondition: genuinely multi-tile

    // DEVIATION FROM PLAN (geometry): the plan's per-tile entry placement assumed a
    // SINGLE tile-row and searched only `lon` at a fixed `lat`. But `tilesForViewport`
    // pads the bbox by the overlap half-step on every side, so this VIEW genuinely spans
    // ≥2 ROWS (y in -1..2) as well as ≥2 cols — a fixed-lat lon-search can't pin a y≠0
    // tile and the plan's own hard-assert fails LOUDLY (its stated failure mode). The
    // faithful pin is the tile CENTER: invert the grid for {x,y} (city anchor → fixed
    // refLat for the lon step), which round-trips `tileCoordAt` for EVERY fetched tile.
    // The entry need not be inside VIEW — the loader inserts every payload entry (no
    // bbox filter on the poiIndex write), so pinning to the tile center is exact.
    const KM_PER_DEG_LAT = 111.32;
    const kmPerDegLon = (latDeg: number) => KM_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
    const tileCenter = (x: number, y: number): { lat: number; lon: number } => {
      const stepLat = 12 / KM_PER_DEG_LAT;
      const stepLon = 12 / kmPerDegLon(VILNIUS_ANCHOR.refLat);
      return {
        lat: VILNIUS_ANCHOR.minLat + (y + 0.5) * stepLat,
        lon: VILNIUS_ANCHOR.minLon + (x + 0.5) * stepLon,
      };
    };

    const seenKeys: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const tileKey = canonicalTileKeyFromUrl(url);
      seenKeys.push(tileKey);
      // One entry per tile, id derived from the tile key so each tile's
      // contribution is independently checkable in poiIndex.
      const safeId = tileKey.replace(/[^0-9a-z]/gi, "_");
      // PIN the entry inside the fetched tile via its CENTER coordinate, which
      // tileCoordAt maps back to this tile's {x,y} — not a fragile base+x*step round-trip.
      const [, , xy] = tileKey.split("/");
      const [x, y] = xy.split("_").map(Number);
      const { lat, lon } = tileCenter(x, y);
      // hard-assert the placement is correct so a fixture drift fails LOUDLY, not silently.
      expect(tileCoordAt(lat, lon, 12, VILNIUS_ANCHOR)).toEqual({ x, y });
      return tilePayloadResponse(tileKey, [makeEntry(safeId, lat, lon)]);
    }) as unknown as typeof fetch;

    const loader = createTileLoader({
      cityId: "vilnius", edgeKm: 12, anchor: VILNIUS_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(VIEW);
    loader.dispose();

    // >=2 DISTINCT tile keys requested
    const distinct = new Set(seenKeys);
    expect(distinct.size).toBeGreaterThan(1);
    for (const k of seenKeys) expect(k).toMatch(/^vilnius\/12km\/-?\d+_-?\d+$/);
    // seam coverage: each fetched tile's entry landed in the merged poiIndex
    for (const k of distinct) {
      const safeId = k.replace(/[^0-9a-z]/gi, "_");
      const row = await db.poiIndex.get(`vilnius:${safeId}`);
      expect(row).toBeDefined();
      expect(row?.loadSource).toBe("tile");
    }
    expect(reportError).not.toHaveBeenCalled();
  });

  it("AC-F1-dedup: a POI in BOTH the vilnius tile AND the loose bundle lands in poiIndex exactly once", async () => {
    const VILNIUS_ANCHOR = { minLat: 54.58, minLon: 25.08, refLat: 54.68 };
    const SHARED_ID = "shared-poi-1";
    const lat = 54.625, lon = 25.20; // inside one vilnius 12km tile
    const tileKey = tileKeyAt("vilnius", lat, lon, 12, VILNIUS_ANCHOR);
    const tileXY = tileCoordAt(lat, lon, 12, VILNIUS_ANCHOR);
    const VIEW: Bbox = { minLat: lat - 0.001, maxLat: lat + 0.001, minLon: lon - 0.001, maxLon: lon + 0.001 };

    // (1) loose whole-bundle write path: the EXACT terminal bulkPut syncPoiBundle does
    //     for a loose bundle, keyed via entryToRecord → `vilnius:shared-poi-1`.
    const sharedEntry = makeEntry(SHARED_ID, lat, lon);
    await db.poiIndex.bulkPut([entryToRecord(sharedEntry, "vilnius")]);

    // (2) tile path: loadViewport over a viewport covering the SAME tile, whose
    //     payload carries the SAME entry.id (so both resolve to `vilnius:shared-poi-1`).
    const fetchImpl = vi.fn(async (url: string) => {
      const key = canonicalTileKeyFromUrl(url);
      // payload only carries the shared entry when its tile is the one fetched.
      const xy = key.split("/")[2].split("_").map(Number);
      const entries = (xy[0] === tileXY.x && xy[1] === tileXY.y) ? [makeEntry(SHARED_ID, lat, lon)] : [];
      return tilePayloadResponse(key, entries);
    }) as unknown as typeof fetch;
    const loader = createTileLoader({
      cityId: "vilnius", edgeKm: 12, anchor: VILNIUS_ANCHOR,
      bundleSha256: BUNDLE_SHA256,
      generationId: GENERATION_ID,
      fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
    });
    await loader.loadViewport(VIEW);
    loader.dispose();

    // Dexie poiIndex bulkPut dedups on the primary key `vilnius:shared-poi-1` →
    // exactly one row despite two write paths.
    expect(await db.poiIndex.get(`vilnius:${SHARED_ID}`)).toBeDefined();
    const rows = await db.poiIndex.where("id").equals(`vilnius:${SHARED_ID}`).toArray();
    expect(rows.length).toBe(1);
    // Total dedup observable: only the shared POI exists across BOTH write paths.
    // (Flip the tile-path id to a DIFFERENT value and this becomes 2 — the
    // non-vacuity proof that the single-row outcome IS the dedup, not one path
    // silently no-op'ing.)
    expect(await db.poiIndex.count()).toBe(1);
    expect(tileKey).toMatch(/^vilnius\/12km\/-?\d+_-?\d+$/); // sanity: the tile key is well-formed
  });

  describe("tile-defense policy wiring (M11 dispatchTileLoad/startDecoyTimer)", () => {
    // 3x2 bounded pool: gdansk/12km/{0,1,2}_{0,1} — small enough to assert
    // over exactly, big enough to exercise padding/decoys meaningfully.
    const POOL_BOUNDS = { minX: 0, maxX: 2, minY: 0, maxY: 1 };
    const POOL_KEYS = [
      "gdansk/12km/0_0", "gdansk/12km/1_0", "gdansk/12km/2_0",
      "gdansk/12km/0_1", "gdansk/12km/1_1", "gdansk/12km/2_1",
    ];

    function fetchImplFor() {
      const mock = vi.fn((url: string) => {
        const tileKey = canonicalTileKeyFromUrl(url);
        return Promise.resolve(tilePayloadResponse(tileKey, []));
      });
      return { mock, fetchImpl: mock as unknown as typeof fetch };
    }

    // A fetchImpl that 404s (no caching, no throw) until `arm()` is called —
    // lets a test drive a "prefetched, but nothing actually landed in the
    // cache yet" round 1 (real HTTP responses would otherwise populate
    // db.poiTileCache for the WHOLE bounded pool on the first bulk prefetch,
    // making every subsequent decoy/padding candidate look already-cached).
    function armableFetchImpl() {
      let armed = false;
      const mock = vi.fn((url: string) => {
        if (!armed) return Promise.resolve(new Response(null, { status: 404 }));
        const tileKey = canonicalTileKeyFromUrl(url);
        return Promise.resolve(tilePayloadResponse(tileKey, []));
      });
      return {
        mock,
        fetchImpl: mock as unknown as typeof fetch,
        arm: () => { armed = true; },
      };
    }

    it("baseline: viewport-only — no pool prefetch, no decoys", async () => {
      const { tileLoader, privacyStore } = await freshModules();
      privacyStore.usePrivacyStore.getState().setLevel("baseline");
      const { mock, fetchImpl } = fetchImplFor();
      const loader = tileLoader.createTileLoader({
        cityId: "gdansk", edgeKm: 12, anchor: GLOBAL_ANCHOR,
        bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID,
        tileBounds: POOL_BOUNDS, fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
      });
      await loader.prefetchTiles(["gdansk/12km/0_0"], new AbortController().signal);
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(
        expect.stringContaining("gdansk/12km/0_0"),
        expect.anything(),
      );
    });

    it("standard: prefetches the full bounded city pool on first load", async () => {
      const { tileLoader, privacyStore } = await freshModules();
      privacyStore.usePrivacyStore.getState().setLevel("standard");
      const { mock, fetchImpl } = fetchImplFor();
      const loader = tileLoader.createTileLoader({
        cityId: "gdansk", edgeKm: 12, anchor: GLOBAL_ANCHOR,
        bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID,
        tileBounds: POOL_BOUNDS, fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
      });
      await loader.prefetchTiles(["gdansk/12km/0_0"], new AbortController().signal);
      expect(mock).toHaveBeenCalledTimes(POOL_KEYS.length);
      for (const key of POOL_KEYS) {
        expect(mock).toHaveBeenCalledWith(expect.stringContaining(key), expect.anything());
      }
      expect(privacyStore.usePrivacyStore.getState().prefetchedCities).toHaveProperty("gdansk");
    });

    it("hardened (padding): a post-prefetch cycle pads the real tile with 2 decoys from the pool", async () => {
      const { tileLoader, privacyStore } = await freshModules();
      privacyStore.usePrivacyStore.getState().setLevel("hardened");
      const { mock, fetchImpl, arm } = armableFetchImpl();
      const loader = tileLoader.createTileLoader({
        cityId: "gdansk", edgeKm: 12, anchor: GLOBAL_ANCHOR,
        bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID,
        tileBounds: POOL_BOUNDS, fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
      });
      // First call: 404s (nothing lands in the cache) but the PLAN still
      // marks the city prefetched — matches dispatchTileLoad's own
      // "triggers full-city prefetch on first load" behavior (see
      // tileDefense.test.ts). Real fetch success/failure is orthogonal to
      // markPrefetched, which is driven by the plan alone.
      await loader.prefetchTiles(["gdansk/12km/0_0"], new AbortController().signal);
      mock.mockClear();
      arm();
      // Second call: prefetched is now true and nothing is actually cached
      // yet, so this cycle is real+decoys only, all landing for real.
      await loader.prefetchTiles(["gdansk/12km/1_1"], new AbortController().signal);
      const calledKeys = mock.mock.calls.map((c) => canonicalTileKeyFromUrl(c[0]));
      expect(calledKeys).toContain("gdansk/12km/1_1");
      expect(calledKeys.length).toBe(3); // 1 real + 2 padding decoys
      for (const key of calledKeys) {
        if (key !== "gdansk/12km/1_1") expect(POOL_KEYS).toContain(key);
      }
    });

    it("paranoid: starts the decoy timer, fires through the loader, and stops it on dispose", async () => {
      const { tileLoader, privacyStore } = await freshModules();
      privacyStore.usePrivacyStore.getState().setLevel("paranoid");
      const tileDefenseMod = await import("./tileDefense.ts");
      const startDecoyTimerMock = vi.mocked(tileDefenseMod.startDecoyTimer);
      const { mock, fetchImpl, arm } = armableFetchImpl();
      const loader = tileLoader.createTileLoader({
        cityId: "gdansk", edgeKm: 12, anchor: GLOBAL_ANCHOR,
        bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID,
        tileBounds: POOL_BOUNDS, fetchImpl, debounceMs: TEST_DEBOUNCE_MS,
      });
      // 404s: the timer starts (decoyTimerActive is unconditional for this
      // strategy) but nothing lands in the cache, so the manually-fired
      // decoy below still finds its target uncached.
      await loader.prefetchTiles(["gdansk/12km/0_0"], new AbortController().signal);
      expect(startDecoyTimerMock).toHaveBeenCalledTimes(1);
      const call = startDecoyTimerMock.mock.calls[0][0];
      expect(call.cityTileKeys).toEqual(POOL_KEYS);

      mock.mockClear();
      arm();
      await call.onFire("gdansk/12km/2_1");
      expect(mock).toHaveBeenCalledWith(
        expect.stringContaining("gdansk/12km/2_1"),
        expect.anything(),
      );

      const stopMock = startDecoyTimerMock.mock.results[0].value.stop as ReturnType<typeof vi.fn>;
      expect(stopMock).not.toHaveBeenCalled();
      loader.dispose();
      expect(stopMock).toHaveBeenCalledTimes(1);
    });
  });
});
