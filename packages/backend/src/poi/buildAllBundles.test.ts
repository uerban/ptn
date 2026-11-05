import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { brotliDecompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  buildAll,
  selectPoiCities,
  checkSizeLimits,
  formatSize,
  SIZE_LIMITS,
  buildAllBundles,
  deriveCityTiling,
  type BundleResult,
  type SizeViolation,
  type SubKSkip,
} from "./buildAllBundles.js";
import type { CityProfile } from "./cityProfiles.js";
import type { PoiEntry } from "@pt/shared";
import { TileKAnonymityViolation } from "./buildBundle.js";
import { CITY_PROFILES } from "./cityProfiles.js";
import { GDANSK_STRICT_FIXTURE } from "./__fixtures__/gdanskStrictFixture.js";
import { VILNIUS_STRICT_FIXTURE } from "./__fixtures__/vilniusStrictFixture.js";
import { derivePoiTileEdge } from "./derivePoiTileEdge.js";
import { tileKeyAt } from "@pt/shared";

describe("checkSizeLimits", () => {
  it("returns empty array when all bundles are within limits", () => {
    const results: BundleResult[] = [
      {
        cityId: "gdansk",
        tier: "strict",
        entryCount: 100,
        compressedSize: 400 * 1024,
        outputPath: "/tmp/gdansk.br",
      },
      {
        cityId: "gdansk",
        tier: "loose",
        entryCount: 5000,
        compressedSize: 1.5 * 1024 * 1024,
        outputPath: "/tmp/gdansk.loose.br",
      },
    ];
    expect(checkSizeLimits(results)).toEqual([]);
  });

  it("flags strict bundles over 500 kB", () => {
    const results: BundleResult[] = [
      {
        cityId: "gdansk",
        tier: "strict",
        entryCount: 600,
        compressedSize: 501 * 1024,
        outputPath: "/tmp/gdansk.br",
      },
    ];
    const violations = checkSizeLimits(results);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      cityId: "gdansk",
      tier: "strict",
      actual: 501 * 1024,
      limit: SIZE_LIMITS.strict,
    });
  });

  it("flags loose bundles over 2 MB", () => {
    const results: BundleResult[] = [
      {
        cityId: "vilnius",
        tier: "loose",
        entryCount: 10000,
        compressedSize: 2.1 * 1024 * 1024,
        outputPath: "/tmp/vilnius.loose.br",
      },
    ];
    const violations = checkSizeLimits(results);
    expect(violations).toHaveLength(1);
    expect(violations[0].tier).toBe("loose");
    expect(violations[0].actual).toBeGreaterThan(SIZE_LIMITS.loose);
  });

  it("handles exact boundary values (at limit = ok)", () => {
    const results: BundleResult[] = [
      {
        cityId: "sopot",
        tier: "strict",
        entryCount: 50,
        compressedSize: SIZE_LIMITS.strict,
        outputPath: "/tmp/sopot.br",
      },
    ];
    expect(checkSizeLimits(results)).toEqual([]);
  });

  it("reports multiple violations across cities", () => {
    const results: BundleResult[] = [
      {
        cityId: "gdansk",
        tier: "strict",
        entryCount: 600,
        compressedSize: 600 * 1024,
        outputPath: "/tmp/gdansk.br",
      },
      {
        cityId: "vilnius",
        tier: "strict",
        entryCount: 700,
        compressedSize: 550 * 1024,
        outputPath: "/tmp/vilnius.br",
      },
      {
        cityId: "gdynia",
        tier: "strict",
        entryCount: 100,
        compressedSize: 200 * 1024,
        outputPath: "/tmp/gdynia.br",
      },
    ];
    const violations = checkSizeLimits(results);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.cityId)).toEqual(["gdansk", "vilnius"]);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 kB");
    expect(formatSize(500 * 1024)).toBe("500.0 kB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.00 MB");
    expect(formatSize(2.5 * 1024 * 1024)).toBe("2.50 MB");
  });
});

describe("SIZE_LIMITS", () => {
  it("strict limit is 500 kB", () => {
    expect(SIZE_LIMITS.strict).toBe(500 * 1024);
  });

  it("loose limit is 2 MB", () => {
    expect(SIZE_LIMITS.loose).toBe(2 * 1024 * 1024);
  });
});

const DERIVE_BBOX = {
  minLon: 18.4,
  minLat: 54.28,
  maxLon: 18.75,
  maxLat: 54.45,
};
const deriveProfile: CityProfile = {
  cityId: "gdansk",
  sourcePbf: "x",
  bbox: DERIVE_BBOX,
  strictTier: true,
  looseTier: false,
};
function deriveCluster(n: number): PoiEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: `E${i}`,
    aliases: {},
    category: "landmark",
    lat: 54.35 + i * 1e-6,
    lon: 18.6 + i * 1e-6,
    source: "osm" as const,
    rankBoost: 0.3,
    tier: "strict" as const,
  }));
}

const KANON_PROFILE: CityProfile = {
  cityId: "gdansk",
  sourcePbf: "x",
  bbox: DERIVE_BBOX,
  strictTier: true,
  looseTier: false,
};
const WAIVED_PROFILE: CityProfile = {
  cityId: "vilnius",
  sourcePbf: "x",
  bbox: DERIVE_BBOX,
  strictTier: true,
  looseTier: false,
  tilingPolicy: "fixed-edge",
  poiTileEdgeKm: 3,
  kAnonWaived: true,
};

/** A cluster that spreads across ≥2 tiles at the finest k-anon edge (12 km),
 *  with one tile holding < TILE_MIN_K, so the per-tile floor genuinely fails. */
function subKSpread(): PoiEntry[] {
  const dense = Array.from({ length: 60 }, (_, i) => ({
    id: `d${i}`, name: `D${i}`, aliases: {}, category: "landmark",
    lat: 54.30 + i * 1e-6, lon: 18.42 + i * 1e-6,
    source: "osm" as const, rankBoost: 0.3, tier: "strict" as const,
  }));
  const sparse = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`, name: `S${i}`, aliases: {}, category: "landmark",
    lat: 54.44 + i * 1e-6, lon: 18.74 + i * 1e-6,
    source: "osm" as const, rankBoost: 0.3, tier: "strict" as const,
  }));
  return [...dense, ...sparse];
}

describe("deriveCityTiling — baseline (deliveryActive=false)", () => {
  it("returns a poiTile block for a normal city (default policy)", () => {
    const r = deriveCityTiling(KANON_PROFILE, deriveCluster(60), {}, false);
    expect(r.skip).toBeUndefined();
    expect(r.poiTile).toMatchObject({ tilingPolicy: "k-anon-floor", kAnonWaived: false });
    expect(r.poiTile!.edgeKm).toBeGreaterThan(0);
  });

  it("warn-and-skips a < k-total city with a structured skip record (AC-2c sub-k-total)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = deriveCityTiling(KANON_PROFILE, deriveCluster(30), {}, false);
    expect(r.poiTile).toBeUndefined();
    const s = r.skip as SubKSkip;
    expect(s).toMatchObject({ cityId: "gdansk", tier: "strict", totalCount: 30 });
    expect(Array.isArray(s.dropped)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warn-and-skip omits ONLY the tile block — { skip } with no poiTile (whole-bundle .br still ships)", () => {
    // A sub-k-total city returns { skip } with NO poiTile. The buildAllBundles loop writes the
    // whole-bundle.br BEFORE the tile derivation (the tile block is additive), so the city is NOT
    // omitted from the build — its POIs ship in the whole bundle and the manifest entry simply
    // carries no poiTile. The frontend's matching half (null tiling → eager whole-bundle fallback,
    // no POI dropped) is AC-19's mixed fan-out test.
    const r = deriveCityTiling(KANON_PROFILE, deriveCluster(30), {}, false);
    expect(r.poiTile).toBeUndefined();
    expect(r.skip).toBeDefined();
  });
});

describe("deriveCityTiling — tightened gate on activation (AC-2)", () => {
  it("AC-2a: env-waived fixed-edge (per-city kAnonWaived UNSET) + deliveryActive + sub-k tile → RETHROWS TileKAnonymityViolation", () => {
    // A k-anon-floor city can NEVER hit this: derivePoiTileEdge climbs the ladder
    // until every tile >= k, so its DERIVED edge has no sub-k tile. The real throw
    // path is the two-level waiver — env POI_KANON_WAIVED=1 lets resolveTilingPolicy
    // SELECT the non-default policy, but the activation k-gate keys on the per-CITY
    // profile.kAnonWaived (UNSET here), so it still enforces the per-tile floor.
    // fixed-edge passes the requested edge straight through, so subKSpread() yields
    // a genuine sub-k (5-entry) tile at 3 km → assertTilesMeetK throws.
    const envWaivedProfile: CityProfile = {
      cityId: "gdansk",
      sourcePbf: "x",
      bbox: DERIVE_BBOX,
      strictTier: true,
      looseTier: false,
      tilingPolicy: "fixed-edge",
      poiTileEdgeKm: 3,
      // kAnonWaived intentionally UNSET — env waiver only
    };
    expect(() =>
      deriveCityTiling(envWaivedProfile, subKSpread(), { POI_KANON_WAIVED: "1" }, true),
    ).toThrow(TileKAnonymityViolation);
  });

  it("AC-2b: explicitly-waived self-host + deliveryActive → no per-tile floor, no throw", () => {
    const r = deriveCityTiling(WAIVED_PROFILE, subKSpread(), {}, true);
    expect(r.skip).toBeUndefined();
    expect(r.poiTile).toMatchObject({ tilingPolicy: "fixed-edge", kAnonWaived: true });
  });

  it("AC-2d: unwaived non-default policy hard-errors at resolveTilingPolicy regardless of deliveryActive", () => {
    const unwaived: CityProfile = {
      cityId: "gdansk", sourcePbf: "x", bbox: DERIVE_BBOX,
      strictTier: true, looseTier: false, tilingPolicy: "byte-budget",
    };
    expect(() => deriveCityTiling(unwaived, deriveCluster(60), {}, true)).toThrow(/requires/i);
    expect(() => deriveCityTiling(unwaived, deriveCluster(60), {}, false)).toThrow(/requires/i);
  });

  it("AC-18: deliveryActive=true derivation is byte-identical across runs", () => {
    const a = deriveCityTiling(KANON_PROFILE, deriveCluster(60), {}, true);
    const b = deriveCityTiling(KANON_PROFILE, deriveCluster(60), {}, true);
    expect(JSON.stringify(a.poiTile)).toBe(JSON.stringify(b.poiTile));
  });
});

describe("buildAllBundles (curated-only, no PBF)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "poi-build-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("builds only selected corpora and excludes unrelated files from the manifest", async () => {
    const outputDir = join(tmpDir, "selected");
    const results = await buildAllBundles({
      outputDir,
      pbfCacheDir: join(tmpDir, "unused-cache"),
      landmarksDir: join(import.meta.dirname, "../../../../packages/shared/test-fixtures/landmarks"),
      cityIds: ["vilnius"],
      skipDownload: true,
      skipKAnonymityValidation: true,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.cityId === "vilnius")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.bundles.every((bundle: { cityId: string }) => bundle.cityId === "vilnius")).toBe(true);
    expect((await readdir(outputDir)).some((name) => /gdansk|gdynia|sopot|tbilisi/.test(name))).toBe(false);
    expect(selectPoiCities("vilnius,vilnius")).toEqual(["vilnius"]);
    expect(() => selectPoiCities("tricity")).toThrow("known corpus");
    expect(() => selectPoiCities("")).toThrow("known corpus");
    expect(() => selectPoiCities("__proto__")).toThrow("known corpus");
  });

  it("builds bundles for all cities from curated landmarks only", async () => {
    const rootDir = join(import.meta.dirname, "../../../..");
    const landmarksDir = join(rootDir, "packages/shared/test-fixtures/landmarks");
    const outputDir = join(tmpDir, "output");
    const pbfCacheDir = join(tmpDir, "pbf-cache");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await buildAllBundles({
      outputDir,
      pbfCacheDir,
      landmarksDir,
      skipDownload: true,
      skipKAnonymityValidation: true,
    });
    warn.mockRestore();

    expect(results.length).toBeGreaterThanOrEqual(3);

    // Curated-only: sopot has < k=50 curated landmarks, so under the default
    // k-anon-floor policy it is warn-and-skipped (no strict bundle / manifest
    // entry). The other three exceed k. (The real PBF build covers all four.)
    const strictResults = results.filter((r) => r.tier === "strict");
    const cityIds = strictResults.map((r) => r.cityId).sort();
    expect(cityIds).toEqual(["gdansk", "gdynia", "vilnius"]);

    const skips = JSON.parse(
      readFileSync(join(outputDir, "poi-sub-k-skips.json"), "utf8"),
    );
    expect(skips.map((s: SubKSkip) => s.cityId)).toEqual(["sopot", "tbilisi"]);

    for (const r of strictResults) {
      expect(r.entryCount).toBeGreaterThan(0);
      expect(r.compressedSize).toBeGreaterThan(0);

      const compressed = readFileSync(r.outputPath);
      const json = brotliDecompressSync(compressed).toString("utf-8");
      const bundle = JSON.parse(json);
      expect(bundle.meta.cityId).toBe(r.cityId);
      expect(bundle.meta.tier).toBe("strict");
      expect(bundle.meta.attribution).toBe("\u00a9 OpenStreetMap contributors");
      expect(bundle.entries).toHaveLength(r.entryCount);
    }

    const looseResults = results.filter((r) => r.tier === "loose");
    const looseCities = looseResults.map((r) => r.cityId).sort();
    expect(looseCities).toEqual(["gdansk", "gdynia", "tbilisi", "vilnius"]);
  }, 30_000);

  it("passes size limits for curated-only bundles", async () => {
    const rootDir = join(import.meta.dirname, "../../../..");
    const landmarksDir = join(rootDir, "packages/shared/test-fixtures/landmarks");
    const outputDir = join(tmpDir, "output");
    const pbfCacheDir = join(tmpDir, "pbf-cache");

    const results = await buildAllBundles({
      outputDir,
      pbfCacheDir,
      landmarksDir,
      skipDownload: true,
      skipKAnonymityValidation: true,
    });

    const violations = checkSizeLimits(results);
    expect(violations).toEqual([]);
  }, 60_000);

  it("emits per-tile .br files when emitTiles is set", async () => {
    const rootDir = join(import.meta.dirname, "../../../..");
    const landmarksDir = join(rootDir, "packages/shared/test-fixtures/landmarks");
    const outputDir = join(tmpDir, "output");
    const pbfCacheDir = join(tmpDir, "pbf-cache");

    const { bundles, tiles } = await buildAll({
      outputDir,
      pbfCacheDir,
      landmarksDir,
      skipDownload: true,
      skipKAnonymityValidation: true,
      emitTiles: true,
    });

    expect(bundles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeGreaterThan(0);

    for (const t of tiles) {
      const stats = await stat(t.outputPath);
      expect(stats.size).toBe(t.compressedSize);
      expect(t.outputPath).toContain(join(outputDir, "tiles"));
    }

    const strictBundles = bundles.filter((b) => b.tier === "strict");
    for (const b of strictBundles) {
      const cityTiles = tiles.filter((t) => t.cityId === b.cityId);
      const tileEntryTotal = cityTiles.reduce(
        (sum, t) => sum + t.entryCount,
        0,
      );
      expect(tileEntryTotal).toBe(b.entryCount);
    }
  }, 60_000);

  it("does not emit tiles when emitTiles is unset", async () => {
    const rootDir = join(import.meta.dirname, "../../../..");
    const landmarksDir = join(rootDir, "packages/shared/test-fixtures/landmarks");
    const outputDir = join(tmpDir, "output");
    const pbfCacheDir = join(tmpDir, "pbf-cache");

    const { tiles } = await buildAll({
      outputDir,
      pbfCacheDir,
      landmarksDir,
      skipDownload: true,
      skipKAnonymityValidation: true,
    });

    expect(tiles).toEqual([]);
    const files = await readdir(outputDir);
    expect(files).not.toContain("tiles");
  }, 30_000);

  it("creates output files with .br extension", async () => {
    const rootDir = join(import.meta.dirname, "../../../..");
    const landmarksDir = join(rootDir, "packages/shared/test-fixtures/landmarks");
    const outputDir = join(tmpDir, "output");
    const pbfCacheDir = join(tmpDir, "pbf-cache");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await buildAllBundles({
      outputDir,
      pbfCacheDir,
      landmarksDir,
      skipDownload: true,
      skipKAnonymityValidation: true,
    });
    warn.mockRestore();

    const files = await readdir(outputDir);
    // sopot is curated-only < k → warn-and-skipped (no sopot.br), and the
    // skip artifact is emitted instead.
    const expected = [
      "gdansk.br",
      "gdansk.loose.br",
      "gdynia.br",
      "gdynia.loose.br",
      "manifest.json",
      "poi-sub-k-skips.json",
      "tbilisi.loose.br",
      "vilnius.br",
      "vilnius.loose.br",
    ];
    expect(files.sort()).toEqual(expected);
  }, 30_000);
});

import { createBundleFileLoader } from "../routes/poiTile.js";
import { writeFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { writeManifest } from "./manifest.js";

describe("manifest writer ↔ backend resolver edge agreement (AC-3a build-parity)", () => {
  it("resolveCityTiling(city).{edgeKm,anchor} deep-equals deriveCityTiling's emitted poiTile block", async () => {
    const profile: CityProfile = {
      cityId: "gdansk", sourcePbf: "x", bbox: DERIVE_BBOX,
      strictTier: true, looseTier: false,
    };
    const entries = deriveCluster(60);
    // BUILD side (what gets written into manifest.json's poiTile block):
    const built = deriveCityTiling(profile, entries, {}, true);
    expect(built.poiTile).toBeDefined();

    // BACKEND-RESOLVER side (what the live route validates tileSize against):
    const dir = await mkdtemp(join(tmpdir(), "poi-parity-"));
    const compressed = brotliCompressSync(Buffer.from(JSON.stringify({
      meta: { cityId: "gdansk", tier: "strict", entryCount: entries.length },
      entries,
    })));
    await writeFile(join(dir, "gdansk.br"), compressed);
    writeManifest(dir, [{
      cityId: "gdansk",
      filename: "gdansk.br",
      sizeBytes: compressed.length,
      poiTile: built.poiTile!,
    }], () => 0);
    const deps = createBundleFileLoader({ bundleDir: dir });
    const resolved = await deps.resolveCityTiling("gdansk");
    expect(resolved.status).toBe("active");
    if (resolved.status === "active") {
      expect(resolved.edgeKm).toBe(built.poiTile!.edgeKm);
      expect(resolved.anchor).toEqual(built.poiTile!.anchor);
    }
    await rm(dir, { recursive: true, force: true });
  });
});

const GDANSK_PROFILE = CITY_PROFILES.gdansk;
const GDANSK_ANCHOR = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };

describe("gdansk activation — scoping + determinism + committed fixture (AC-14/AC-15/AC-16)", () => {
  it("AC-A3: ALL FIVE profiles carry poiTileDeliveryActive (exact set-equality + value)", () => {
    expect(
      Object.values(CITY_PROFILES)
        .filter((p) => p.poiTileDeliveryActive !== undefined)
        .map((p) => p.cityId),
    ).toEqual(["gdansk", "gdynia", "sopot", "vilnius", "tbilisi"]); // CITY_PROFILES key order
    for (const id of ["gdansk", "gdynia", "sopot", "vilnius", "tbilisi"] as const) {
      expect(CITY_PROFILES[id].poiTileDeliveryActive).toBe(true);
    }
  });

  it("AC-15: activated gdansk derivation is byte-identical across runs AND pins edge 24 + anchor", () => {
    const a = deriveCityTiling(GDANSK_PROFILE, GDANSK_STRICT_FIXTURE, {}, true);
    const b = deriveCityTiling(GDANSK_PROFILE, GDANSK_STRICT_FIXTURE, {}, true);
    expect(JSON.stringify(a.poiTile)).toBe(JSON.stringify(b.poiTile));
    expect(a.poiTile).toBeDefined();
    expect(a.poiTile!.edgeKm).toBe(24);
    expect(a.poiTile!.anchor).toEqual(GDANSK_ANCHOR);
  });

  it("AC-16: committed fixture activates without TileKAnonymityViolation and derives EXACTLY ONE tile", () => {
    // No throw on activation.
    const r = deriveCityTiling(GDANSK_PROFILE, GDANSK_STRICT_FIXTURE, {}, true);
    expect(r.skip).toBeUndefined();
    expect(r.poiTile).toBeDefined();
    expect(r.poiTile!.edgeKm).toBe(24);
    expect(r.poiTile!.anchor).toEqual(GDANSK_ANCHOR);
    // LOAD-BEARING k-safety guard: EXACTLY ONE tile (independent of the edge
    // VALUE — edge 24 is also satisfiable by a multi-tile ladder derivation).
    // Every entry maps to the same tile key at the derived edge+anchor.
    const tiles = new Set(
      GDANSK_STRICT_FIXTURE.map((e) =>
        tileKeyAt("c", e.lat, e.lon, r.poiTile!.edgeKm, r.poiTile!.anchor),
      ),
    );
    expect(tiles.size).toBe(1);
    // And the standalone derivation agrees on the edge (corpus ≥ TILE_MIN_K, so
    // derivePoiTileEdge does NOT throw the < k floor error).
    const d = derivePoiTileEdge(GDANSK_STRICT_FIXTURE, "k-anon-floor", GDANSK_PROFILE.bbox, {});
    expect(d.edgeKm).toBe(24);
  });
});

const VILNIUS_PROFILE = CITY_PROFILES.vilnius;
const VILNIUS_ANCHOR = { minLat: 54.58, minLon: 25.08, refLat: 54.68 };

describe("vilnius activation — multi-tile + per-tile-k + determinism (AC-B1)", () => {
  it("AC-B1: activated vilnius derivation is multi-tile, every tile >= k, edge 12, byte-deterministic", () => {
    // (a) does NOT throw TileKAnonymityViolation on activation
    const a = deriveCityTiling(VILNIUS_PROFILE, VILNIUS_STRICT_FIXTURE, {}, true);
    expect(a.skip).toBeUndefined();
    expect(a.poiTile).toBeDefined();
    // (b) edge 12 + the fixed anchor
    expect(a.poiTile!.edgeKm).toBe(12);
    expect(a.poiTile!.anchor).toEqual(VILNIUS_ANCHOR);
    // (c) MORE THAN ONE tile (the multi-tile property — vilnius is the only one),
    //     with EVERY 12km tile >= TILE_MIN_K (no sub-k cell).
    const tileCounts = new Map<string, number>();
    for (const e of VILNIUS_STRICT_FIXTURE) {
      const key = tileKeyAt("c", e.lat, e.lon, a.poiTile!.edgeKm, a.poiTile!.anchor);
      tileCounts.set(key, (tileCounts.get(key) ?? 0) + 1);
    }
    expect(tileCounts.size).toBeGreaterThan(1);
    for (const count of tileCounts.values()) {
      expect(count).toBeGreaterThanOrEqual(50); // TILE_MIN_K
    }
    // (d) byte-identical across two runs at the fixed anchor
    const b = deriveCityTiling(VILNIUS_PROFILE, VILNIUS_STRICT_FIXTURE, {}, true);
    expect(JSON.stringify(a.poiTile)).toBe(JSON.stringify(b.poiTile));
    // standalone derivation agrees on the edge
    const d = derivePoiTileEdge(VILNIUS_STRICT_FIXTURE, "k-anon-floor", VILNIUS_PROFILE.bbox, {});
    expect(d.edgeKm).toBe(12);
  });
});
