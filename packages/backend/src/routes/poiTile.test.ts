import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  tileKeyAt,
  type PoiEntry,
  type PoiManifest,
  type PoiManifestBundle,
  type PoiTileBounds,
  type TileAnchor,
} from "@pt/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBundleFileLoader,
  createPoiTileHandler,
  poiTileRequestCounts,
  type CityTilingResolution,
  type PoiTileDeps,
} from "./poiTile.js";

const ANCHOR: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
const WIDE_BOUNDS = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
const BUNDLE_SHA = "a".repeat(64);

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
    ...overrides,
  };
}

const ENTRIES: PoiEntry[] = [
  makeEntry("g1", 54.32, 18.45),
  makeEntry("g2", 54.33, 18.46),
  makeEntry("g3", 54.61, 18.74),
];

function makeDeps(overrides: Partial<PoiTileDeps> = {}): PoiTileDeps {
  return {
    loadCityEntries: async (cityId) =>
      cityId === "gdansk" || cityId === "vilnius" ? ENTRIES : null,
    resolveCityTiling: async (cityId): Promise<CityTilingResolution> => {
      if (cityId === "vilnius") {
        return {
          status: "active",
          edgeKm: 12,
          anchor: ANCHOR,
          bounds: WIDE_BOUNDS,
          bundleSha256: BUNDLE_SHA,
        };
      }
      if (cityId === "gdansk") {
        return {
          status: "active",
          edgeKm: 24,
          anchor: ANCHOR,
          bounds: WIDE_BOUNDS,
          bundleSha256: BUNDLE_SHA,
        };
      }
      if (cityId === "off") return { status: "inactive" };
      return { status: "unknown" };
    },
    ...overrides,
  };
}

async function buildApp(
  deps: PoiTileDeps,
): Promise<{ app: FastifyInstance; warnings: string[] }> {
  const warnings: string[] = [];
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.getHeader("cache-control")) {
      reply.header("Cache-Control", "no-store");
    }
    reply.header("X-API-Version", "1");
  });
  app.addHook("onRequest", async (request) => {
    request.log.warn = ((obj: unknown, message?: string) => {
      warnings.push(typeof obj === "string" ? obj : (message ?? JSON.stringify(obj)));
    }) as typeof request.log.warn;
  });
  app.get(
    "/api/gtfs/poi-tile/:cityId/:tileSize/:tileCoords",
    createPoiTileHandler(deps),
  );
  await app.ready();
  return { app, warnings };
}

describe("poiTile route", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildApp(makeDeps()));
  });

  afterAll(async () => {
    await app.close();
  });

  it("validates the manifest edge and returns only the requested tile", async () => {
    const mismatch = await app.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/gdansk/12km/0_0",
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toMatchObject({
      code: "TILE_SIZE_MISMATCH",
    });
    expect(mismatch.json().error.message).toContain("24km");

    const tileKey = tileKeyAt("gdansk", ENTRIES[0].lat, ENTRIES[0].lon, 24, ANCHOR);
    const response = await app.inject({
      method: "GET",
      url: `/api/gtfs/poi-tile/${tileKey}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-poi-attribution"]).toBe(
      "(c) OpenStreetMap contributors",
    );
    const json = JSON.parse(brotliDecompressSync(response.rawPayload).toString("utf8"));
    expect(json.tileKey).toBe(tileKey);
    expect(json.entries.map((entry: PoiEntry) => entry.id).sort()).toEqual(["g1", "g2"]);
  });

  it("returns an empty 200 inside the bounded serving grid and rejects a stale corpus version", async () => {
    const empty = await app.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/gdansk/24km/50_50?v=" + BUNDLE_SHA,
    });
    expect(empty.statusCode).toBe(200);
    expect(
      JSON.parse(brotliDecompressSync(empty.rawPayload).toString("utf8")),
    ).toEqual({
      tileKey: "gdansk/24km/50_50",
      entries: [],
    });

    const stale = await app.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/gdansk/24km/50_50?v=" + "b".repeat(64),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("POI_CORPUS_VERSION_MISMATCH");

    const encodedCurrent = await app.inject({
      method: "GET",
      url:
        "/api/gtfs/poi-tile/gdansk/24km/50_50?v=%61" +
        BUNDLE_SHA.slice(1),
    });
    expect(encodedCurrent.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: "GET",
      url:
        "/api/gtfs/poi-tile/gdansk/24km/50_50?v=" +
        BUNDLE_SHA +
        "&v=" +
        BUNDLE_SHA,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("POI_CORPUS_VERSION_MISMATCH");
  });

  it("rejects malformed coordinates and 404s bounded out-of-grid coordinates before loading entries", async () => {
    let loads = 0;
    const { app: bounded } = await buildApp(
      makeDeps({
        loadCityEntries: async () => {
          loads += 1;
          return ENTRIES;
        },
        resolveCityTiling: async () => ({
          status: "active",
          edgeKm: 24,
          anchor: ANCHOR,
          bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
          bundleSha256: BUNDLE_SHA,
        }),
      }),
    );
    for (const coords of ["00_0", "-0_0", "0_0-0"]) {
      const response = await bounded.inject({
        method: "GET",
        url: `/api/gtfs/poi-tile/gdansk/24km/${coords}`,
      });
      expect(response.statusCode, coords).toBe(400);
      expect(response.json().error.code).toBe("INVALID_TILE_KEY");
    }
    for (const coords of ["2_0", "0_2"]) {
      const response = await bounded.inject({
        method: "GET",
        url: `/api/gtfs/poi-tile/gdansk/24km/${coords}`,
      });
      expect(response.statusCode, coords).toBe(404);
      expect(response.json().error.code).toBe("UNKNOWN_TILE");
    }
    expect(loads).toBe(0);
    await bounded.close();
  });

  it("distinguishes unknown and inactive cities and records statuses", async () => {
    const before = poiTileRequestCounts().get("503") ?? 0;
    const seen: number[] = [];
    const { app: statusApp, warnings } = await buildApp(
      makeDeps({ onRequest: (status) => seen.push(status) }),
    );
    const unknown = await statusApp.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/nope/12km/0_0",
    });
    const inactive = await statusApp.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/off/12km/0_0",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("UNKNOWN_CITY");
    expect(inactive.statusCode).toBe(503);
    expect(inactive.json().error.code).toBe("POI_TILE_DELIVERY_INACTIVE");
    expect(warnings.some((line) => line.includes("UNKNOWN_CITY"))).toBe(true);
    expect(warnings.some((line) => line.includes("POI_TILE_DELIVERY_INACTIVE"))).toBe(true);
    expect(poiTileRequestCounts().get("503")).toBe(before + 1);
    expect(seen).toEqual([404, 503]);
    await statusApp.close();
  });

  it("turns loader failures into the shared 500 contract and records them", async () => {
    const seen: number[] = [];
    const { app: failedApp } = await buildApp(
      makeDeps({
        resolveCityTiling: async () => {
          throw new Error("corrupt manifest");
        },
        onRequest: (status) => seen.push(status),
      }),
    );
    const response = await failedApp.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/gdansk/24km/0_0",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: "POI_BUNDLE_LOAD_ERROR",
      message: "POI data could not be loaded",
    });
    expect(seen).toEqual([500]);
    await failedApp.close();
  });

  it("prewarms validation without materializing route responses", async () => {
    let preflights = 0;
    let entryLoads = 0;
    const handler = createPoiTileHandler(
      makeDeps({
        preflight: async () => {
          preflights += 1;
          return true;
        },
        loadCityEntries: async () => {
          entryLoads += 1;
          return ENTRIES;
        },
      }),
    );

    await expect(handler.prewarm()).resolves.toBe(true);
    expect(preflights).toBe(1);
    expect(entryLoads).toBe(0);
  });

  it("reuses the compressed response for conditional GET and HEAD", async () => {
    let loads = 0;
    const { app: cachedApp } = await buildApp(
      makeDeps({
        loadCityEntries: async () => {
          loads += 1;
          return ENTRIES;
        },
      }),
    );
    const tileKey = tileKeyAt("gdansk", ENTRIES[0].lat, ENTRIES[0].lon, 24, ANCHOR);
    const first = await cachedApp.inject({
      method: "GET",
      url: `/api/gtfs/poi-tile/${tileKey}`,
    });
    const conditional = await cachedApp.inject({
      method: "GET",
      url: `/api/gtfs/poi-tile/${tileKey}`,
      headers: { "if-none-match": first.headers.etag },
    });
    const head = await cachedApp.inject({
      method: "HEAD",
      url: `/api/gtfs/poi-tile/${tileKey}`,
    });
    expect(conditional.statusCode).toBe(304);
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload).toHaveLength(0);
    expect(head.headers.etag).toBe(first.headers.etag);
    expect(loads).toBe(1);
    await cachedApp.close();
  });

  it("matches Fastify path decoding and maxParamLength behavior", async () => {
    const encoded = await app.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/vilniu%73/12%6Bm/0%5F0",
    });
    expect(encoded.statusCode).toBe(200);

    const invalidCity = await app.inject({
      method: "GET",
      url: `/api/gtfs/poi-tile/${"a".repeat(65)}/12km/0_0`,
    });
    expect(invalidCity.statusCode).toBe(400);
    expect(invalidCity.json().error.code).toBe("INVALID_CITY_ID");

    for (const tileSize of ["a".repeat(100), "%61".repeat(100)]) {
      const accepted = await app.inject({
        method: "GET",
        url: `/api/gtfs/poi-tile/vilnius/${tileSize}/0_0`,
      });
      expect(accepted.statusCode, `tileSize length ${tileSize.length}`).toBe(400);
      expect(accepted.json().error.code).toBe("TILE_SIZE_MISMATCH");
    }

    // Since Fastify 5.12 the router rejects an over-long capture itself,
    // before route hooks run, with the decoded path in the message.
    for (const tileSize of ["a".repeat(101), "%61".repeat(101)]) {
      const oversized = await app.inject({
        method: "GET",
        url: `/api/gtfs/poi-tile/vilnius/${tileSize}/0_0`,
      });
      expect(oversized.statusCode, `tileSize length ${tileSize.length}`).toBe(414);
      expect(oversized.json()).toEqual({
        error: "Bad Request",
        code: "FST_ERR_MAX_PARAM_LENGTH",
        message: `'/api/gtfs/poi-tile/vilnius/${"a".repeat(101)}/0_0' is exceeding the max param length`,
        statusCode: 414,
      });
      expect(oversized.headers["cache-control"]).toBeUndefined();
      expect(oversized.headers["x-api-version"]).toBeUndefined();
    }

    const malformed = await app.inject({
      method: "GET",
      url: "/api/gtfs/poi-tile/vilnius/12%/0_0",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: "Bad Request",
      code: "FST_ERR_BAD_URL",
      message:
        "'/api/gtfs/poi-tile/vilnius/12%/0_0' is not a valid url component",
      statusCode: 400,
    });
    expect(malformed.headers["cache-control"]).toBeUndefined();
    expect(malformed.headers["x-api-version"]).toBeUndefined();
  });

  it("applies production CORS and default headers to GET, HEAD, and OPTIONS", async () => {
    const origin = "https://example.test";
    for (const method of ["GET", "HEAD"] as const) {
      const response = await app.inject({
        method,
        url: "/api/gtfs/poi-tile/vilnius/12km/0_0",
        headers: { origin },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers.vary).toBe("Origin");
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["x-api-version"]).toBe("1");
      if (method === "HEAD") expect(response.rawPayload).toHaveLength(0);
    }

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/gtfs/poi-tile/vilnius/12km/0_0",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-test, if-none-match",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.rawPayload).toHaveLength(0);
    expect(preflight.headers).toMatchObject({
      vary: "Origin, Access-Control-Request-Headers",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,HEAD,POST",
      "access-control-allow-headers": "x-test, if-none-match",
      "cache-control": "no-store",
      "x-api-version": "1",
    });
  });
});

interface PublishOptions {
  cityId?: string;
  entries?: PoiEntry[];
  edgeKm?: number;
  deliveryActive?: boolean;
  tileBounds?: PoiTileBounds;
  records?: PoiManifestBundle[];
}

async function publishCity(
  dir: string,
  options: PublishOptions = {},
): Promise<PoiManifestBundle> {
  const cityId = options.cityId ?? "gdansk";
  const entries = options.entries ?? ENTRIES;
  const bundle = {
    meta: { cityId, tier: "strict", entryCount: entries.length },
    entries,
  };
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(bundle)));
  await writeFile(join(dir, `${cityId}.br`), compressed);
  const edgeKm = options.edgeKm ?? 24;
  const occupied = entries.map((entry) => {
    const coords = tileKeyAt(cityId, entry.lat, entry.lon, edgeKm, ANCHOR)
      .split("/")
      .at(-1)!
      .split("_")
      .map(Number);
    return { x: coords[0], y: coords[1] };
  });
  const tileBounds = options.tileBounds ?? {
    minX: Math.min(...occupied.map(({ x }) => x)),
    maxX: Math.max(...occupied.map(({ x }) => x)),
    minY: Math.min(...occupied.map(({ y }) => y)),
    maxY: Math.max(...occupied.map(({ y }) => y)),
  };
  const record: PoiManifestBundle = {
    cityId,
    filename: `${cityId}.br`,
    sizeBytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    poiTile: {
      edgeKm,
      anchor: ANCHOR,
      tileBounds,
      tilingPolicy: "fixed-edge",
      kAnonWaived: true,
      deliveryActive: options.deliveryActive ?? true,
    },
  };
  const manifest: PoiManifest = {
    schemaVersion: 1,
    bundles: options.records ?? [record],
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  return record;
}

describe("createBundleFileLoader", () => {
  it("admits active corpora by operator byte budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-memory-budget-"));
    await publishCity(dir);
    await expect(createBundleFileLoader({bundleDir: dir, entriesCacheMaxBytes: 1}).preflight?.())
      .rejects.toThrow("decoded POI cache exceeds configured byte budget");
    await expect(createBundleFileLoader({bundleDir: dir, entriesCacheMaxBytes: 2 * 1024 * 1024}).preflight?.())
      .resolves.toBe(true);
    await rm(dir, {recursive: true, force: true});
  });

  it("validates before bind without retaining decoded entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-validation-only-"));
    await publishCity(dir);
    const loader = createBundleFileLoader({ bundleDir: dir });
    await expect(loader.preflight?.()).resolves.toBe(true);

    await writeFile(join(dir, "gdansk.br"), Buffer.from("tampered"));
    await expect(loader.loadCityEntries("gdansk")).rejects.toThrow(/bytes|sha256/);
    await rm(dir, { recursive: true, force: true });
  });

  it.each([0, 2, 3])("rejects a manifest with schemaVersion %i", async (version) => {
    const dir = await mkdtemp(join(tmpdir(), "poi-schema-"));
    const record = await publishCity(dir);
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: version, bundles: [record] }),
    );
    await expect(
      createBundleFileLoader({ bundleDir: dir }).resolveCityTiling("gdansk"),
    ).rejects.toThrow(`unsupported POI manifest schemaVersion ${version}`);
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the exact strict manifest record as the serving contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-loader-"));
    const strict = await publishCity(dir);
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            ...strict,
            filename: "gdansk.loose.br",
            poiTile: { ...strict.poiTile, edgeKm: 999 },
          },
          strict,
        ],
      }),
    );
    const resolution = await createBundleFileLoader({ bundleDir: dir }).resolveCityTiling(
      "gdansk",
    );
    expect(resolution).toMatchObject({
      status: "active",
      edgeKm: 24,
      anchor: ANCHOR,
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("does not cache a missing manifest as an unknown city", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-late-"));
    const loader = createBundleFileLoader({ bundleDir: dir });
    expect(await loader.resolveCityTiling("gdansk")).toEqual({ status: "unknown" });
    await publishCity(dir);
    expect(await loader.resolveCityTiling("gdansk")).toMatchObject({
      status: "active",
      edgeKm: 24,
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("returns inactive from the manifest without reading an absent bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-inactive-"));
    const record: PoiManifestBundle = {
      cityId: "gdansk",
      filename: "gdansk.br",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      poiTile: {
        edgeKm: 24,
        anchor: ANCHOR,
        tileBounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
        tilingPolicy: "k-anon-floor",
        kAnonWaived: false,
        deliveryActive: false,
      },
    };
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundles: [record] }),
    );
    expect(await createBundleFileLoader({ bundleDir: dir }).resolveCityTiling("gdansk"))
      .toEqual({ status: "inactive" });
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts ten deployment corpora with per-city delivery inactive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-eight-cities-"));
    const ids = ["vilnius", "gdansk", "gdynia", "sopot", "tbilisi", "krakow", "oslo", "riga", "tallinn", "warsaw"];
    const bundles = ids.map(cityId => ({cityId, filename: `${cityId}.br`, sizeBytes: 1, sha256: "0".repeat(64)}));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({schemaVersion: 1, bundles}));
    const loader = createBundleFileLoader({bundleDir: dir});
    await loader.preflight?.();
    expect(await loader.resolveCityTiling("warsaw")).toEqual({status: "inactive"});
    await rm(dir, {recursive: true, force: true});
  });

  it("accepts larger inactive inventories without an artificial count cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-city-cap-"));
    const bundles = Array.from({ length: 40 }, (_, index): PoiManifestBundle => ({
      cityId: `city${index}`,
      filename: `city${index}.br`,
      sizeBytes: 1,
      sha256: "0".repeat(64),
      poiTile: {
        edgeKm: 12,
        anchor: ANCHOR,
        tileBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
        tilingPolicy: "k-anon-floor",
        kAnonWaived: false,
        deliveryActive: false,
      },
    }));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundles }),
    );
    await expect(createBundleFileLoader({ bundleDir: dir }).preflight?.()).resolves.toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects duplicate strict records, tampering, and metadata drift", async () => {
    const duplicateDir = await mkdtemp(join(tmpdir(), "poi-duplicate-"));
    const record = await publishCity(duplicateDir);
    await writeFile(
      join(duplicateDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundles: [record, record] }),
    );
    await expect(
      createBundleFileLoader({ bundleDir: duplicateDir }).resolveCityTiling("gdansk"),
    ).rejects.toThrow("duplicate strict manifest record");

    const tamperedDir = await mkdtemp(join(tmpdir(), "poi-tampered-"));
    await publishCity(tamperedDir);
    await writeFile(join(tamperedDir, "gdansk.br"), Buffer.from("tampered"));
    await expect(
      createBundleFileLoader({ bundleDir: tamperedDir }).resolveCityTiling("gdansk"),
    ).rejects.toThrow(/bytes|sha256/);

    const metadataDir = await mkdtemp(join(tmpdir(), "poi-metadata-"));
    await publishCity(metadataDir);
    const wrong = {
      meta: { cityId: "vilnius", tier: "strict", entryCount: ENTRIES.length },
      entries: ENTRIES,
    };
    const bytes = brotliCompressSync(Buffer.from(JSON.stringify(wrong)));
    await writeFile(join(metadataDir, "gdansk.br"), bytes);
    const wrongRecord: PoiManifestBundle = {
      ...record,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(
      join(metadataDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundles: [wrongRecord] }),
    );
    await expect(
      createBundleFileLoader({ bundleDir: metadataDir }).resolveCityTiling("gdansk"),
    ).rejects.toThrow("bundle metadata mismatch");

    await Promise.all(
      [duplicateDir, tamperedDir, metadataDir].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects inconsistent privacy metadata and non-strict active entries", async () => {
    const privacyDir = await mkdtemp(join(tmpdir(), "poi-privacy-"));
    const privacyRecord = await publishCity(privacyDir);
    await writeFile(
      join(privacyDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            ...privacyRecord,
            poiTile: {
              ...privacyRecord.poiTile,
              tilingPolicy: "k-anon-floor",
              kAnonWaived: true,
            },
          },
        ],
      }),
    );
    await expect(
      createBundleFileLoader({ bundleDir: privacyDir }).preflight?.(),
    ).rejects.toThrow("k-anonymity waiver");

    const floorDir = await mkdtemp(join(tmpdir(), "poi-floor-"));
    const floorRecord = await publishCity(floorDir);
    await writeFile(
      join(floorDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            ...floorRecord,
            poiTile: {
              ...floorRecord.poiTile,
              tilingPolicy: "k-anon-floor",
              kAnonWaived: false,
            },
          },
        ],
      }),
    );
    await expect(
      createBundleFileLoader({ bundleDir: floorDir }).preflight?.(),
    ).rejects.toThrow("violates k=50");

    const tierDir = await mkdtemp(join(tmpdir(), "poi-tier-"));
    await publishCity(tierDir, {
      entries: [makeEntry("loose", 54.32, 18.45, { tier: "loose" })],
    });
    await expect(
      createBundleFileLoader({ bundleDir: tierDir }).preflight?.(),
    ).rejects.toThrow("strict bundle metadata");

    await Promise.all(
      [privacyDir, floorDir, tierDir].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects active coordinate envelopes larger than the response cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-envelope-"));
    await publishCity(dir, {
      edgeKm: 3,
      tileBounds: { minX: 0, maxX: 30, minY: 0, maxY: 40 },
      entries: [
        makeEntry("a", 54.28, 18.4),
        makeEntry("b", 55.28, 19.4),
      ],
    });
    await expect(
      createBundleFileLoader({
        bundleDir: dir,
        responseCacheMaxEntries: 4,
      }).resolveCityTiling("gdansk"),
    ).rejects.toThrow("cache holds 4 entries");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects aggregate multi-city envelopes larger than the response cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poi-aggregate-envelope-"));
    const gdansk = await publishCity(dir, {
      cityId: "gdansk",
      edgeKm: 3,
      tileBounds: { minX: 0, maxX: 0, minY: 0, maxY: 2 },
      entries: [
        makeEntry("g-a", 54.28, 18.4),
        makeEntry("g-b", 54.34, 18.4),
      ],
    });
    const vilnius = await publishCity(dir, {
      cityId: "vilnius",
      edgeKm: 3,
      tileBounds: { minX: 0, maxX: 0, minY: 0, maxY: 2 },
      entries: [
        makeEntry("v-a", 54.28, 18.4),
        makeEntry("v-b", 54.34, 18.4),
      ],
    });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundles: [gdansk, vilnius] }),
    );
    const loader = createBundleFileLoader({
      bundleDir: dir,
      responseCacheMaxEntries: 3,
    });
    await expect(loader.resolveCityTiling("gdansk")).rejects.toThrow(
      "configured corpora expose 6 coordinates",
    );
    await rm(dir, { recursive: true, force: true });
  });
});
