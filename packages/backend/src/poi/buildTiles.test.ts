import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliDecompressSync } from "node:zlib";
import {
  TILE_SIZE_LABEL,
  tileKeyAt,
  type PoiEntry,
  type TileAnchor,
} from "@pt/shared";
import {
  buildCityTiles,
  buildTilesFromBundleFile,
  encodeTilePayload,
  groupEntriesByTileKey,
  summarizeTileResults,
  tileOutputPath,
  type TileResult,
} from "./buildTiles.js";
import { buildCityBundle, loadLandmarks } from "./buildBundle.js";
import { loadTagSpec } from "./osmTags.js";

function makeEntry(
  id: string,
  lat: number,
  lon: number,
  overrides: Partial<PoiEntry> = {},
): PoiEntry {
  return {
    id,
    name: id,
    aliases: {},
    category: "poi",
    lat,
    lon,
    source: "curated",
    rankBoost: 1,
    tier: "strict",
    ...overrides,
  };
}

describe("groupEntriesByTileKey", () => {
  it("groups entries by their tile key", () => {
    const entries: PoiEntry[] = [
      makeEntry("a", 54.35, 18.65),
      makeEntry("b", 54.35001, 18.65001),
      makeEntry("c", 54.9, 23.9),
    ];
    const grouped = groupEntriesByTileKey("gdansk", entries);
    const keys = Array.from(grouped.keys());
    expect(keys).toHaveLength(2);
    for (const [key, bucket] of grouped) {
      for (const e of bucket) {
        expect(tileKeyAt("gdansk", e.lat, e.lon)).toBe(key);
      }
    }
  });

  it("returns empty map for empty input", () => {
    expect(groupEntriesByTileKey("gdansk", [])).toEqual(new Map());
  });
});

describe("tileOutputPath", () => {
  it("places tiles under outputDir/tiles/<tileKey>.br", () => {
    const path = tileOutputPath("/out", `gdansk/${TILE_SIZE_LABEL}/3_7`);
    expect(path).toBe(`/out/tiles/gdansk/${TILE_SIZE_LABEL}/3_7.br`);
  });
});

describe("encodeTilePayload", () => {
  it("produces Brotli-compressed JSON matching the runtime tile endpoint shape", () => {
    const entries = [makeEntry("a", 54.35, 18.65)];
    const tileKey = tileKeyAt("gdansk", entries[0].lat, entries[0].lon);
    const compressed = encodeTilePayload(tileKey, entries);
    const json = brotliDecompressSync(compressed).toString("utf-8");
    const parsed = JSON.parse(json);
    expect(parsed.tileKey).toBe(tileKey);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].id).toBe("a");
  });
});

describe("buildCityTiles", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "poi-tiles-test-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes one .br file per populated tile", async () => {
    const entries: PoiEntry[] = [
      makeEntry("a", 54.35, 18.65),
      makeEntry("b", 54.36, 18.66),
      makeEntry("c", 54.9, 23.9),
    ];
    const results = await buildCityTiles({
      outputDir: outDir,
      cityId: "gdansk",
      entries,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);

    for (const r of results) {
      const stats = await stat(r.outputPath);
      expect(stats.size).toBe(r.compressedSize);
      const json = brotliDecompressSync(await readFile(r.outputPath)).toString(
        "utf-8",
      );
      const parsed = JSON.parse(json) as { tileKey: string; entries: PoiEntry[] };
      expect(parsed.tileKey).toBe(r.tileKey);
      expect(parsed.entries.length).toBe(r.entryCount);
    }
  });

  it("produces no files when entries is empty", async () => {
    const results = await buildCityTiles({
      outputDir: outDir,
      cityId: "gdansk",
      entries: [],
    });
    expect(results).toEqual([]);
    await expect(readdir(join(outDir, "tiles"))).rejects.toThrow();
  });

  it("creates nested directories for tile keys", async () => {
    const entries = [makeEntry("a", 54.35, 18.65)];
    const results = await buildCityTiles({
      outputDir: outDir,
      cityId: "gdansk",
      entries,
    });
    const r = results[0];
    expect(r.outputPath).toContain(join(outDir, "tiles", "gdansk"));
    expect(r.outputPath).toContain(TILE_SIZE_LABEL);
    expect(r.outputPath.endsWith(".br")).toBe(true);
  });
});

describe("buildTilesFromBundleFile", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "poi-tiles-bundle-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("reads a bundle file and emits per-tile outputs", async () => {
    const rootDir = join(import.meta.dirname, "../../../..");
    const landmarksDir = join(rootDir, "packages/shared/test-fixtures/landmarks");
    const landmarkPath = join(landmarksDir, "gdansk.json");
    const tagSpec = loadTagSpec();
    const landmarkEntries = await loadLandmarks(landmarkPath, "gdansk");

    const { bundle, compressed } = await buildCityBundle("gdansk", {
      tagSpec,
      tier: "strict",
      landmarkEntries,
      skipKAnonymityValidation: true,
    });
    expect(bundle.entries.length).toBeGreaterThan(0);

    const bundlePath = join(outDir, "gdansk.br");
    await (await import("node:fs/promises")).writeFile(bundlePath, compressed);

    const results = await buildTilesFromBundleFile(bundlePath, outDir);
    expect(results.length).toBeGreaterThan(0);

    const totalEntries = results.reduce((sum, r) => sum + r.entryCount, 0);
    expect(totalEntries).toBe(bundle.entries.length);

    for (const r of results) {
      expect(r.cityId).toBe("gdansk");
      expect(r.tileKey.startsWith("gdansk/")).toBe(true);
    }
  }, 30_000);
});

describe("summarizeTileResults", () => {
  it("aggregates counts and sizes per city", () => {
    const results: TileResult[] = [
      {
        cityId: "gdansk",
        tileKey: "gdansk/12km/0_0",
        entryCount: 50,
        compressedSize: 1000,
        outputPath: "/tmp/a",
      },
      {
        cityId: "gdansk",
        tileKey: "gdansk/12km/1_0",
        entryCount: 70,
        compressedSize: 1500,
        outputPath: "/tmp/b",
      },
      {
        cityId: "vilnius",
        tileKey: "vilnius/12km/0_0",
        entryCount: 120,
        compressedSize: 2000,
        outputPath: "/tmp/c",
      },
    ];
    const summary = summarizeTileResults(results);
    const gdansk = summary.find((s) => s.cityId === "gdansk");
    const vilnius = summary.find((s) => s.cityId === "vilnius");
    expect(gdansk).toEqual({ cityId: "gdansk", tileCount: 2, totalSize: 2500 });
    expect(vilnius).toEqual({ cityId: "vilnius", tileCount: 1, totalSize: 2000 });
  });
});

describe("groupEntriesByTileKey with per-city edge+anchor", () => {
  it("keys by the derived edge, origin-relative", () => {
    const anchor: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
    const g = groupEntriesByTileKey("gdansk",
      [{ id: "a", name: "A", aliases: {}, category: "x", lat: 54.28, lon: 18.4, source: "osm" as const, rankBoost: 0.3, tier: "strict" as const }],
      24, anchor);
    expect([...g.keys()]).toEqual(["gdansk/24km/0_0"]);
  });
});
