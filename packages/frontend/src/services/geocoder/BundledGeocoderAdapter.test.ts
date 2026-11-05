import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { db, type PoiIndexRecord } from "../../db/index.ts";
import {
  BundledGeocoderAdapter,
  normalizeQuery,
  scoreCandidate,
  haversineMeters,
} from "./BundledGeocoderAdapter.ts";

vi.mock("../brotliDecode.ts", () => ({
  decompressBrotli: vi.fn(async (buffer: ArrayBuffer) =>
    new TextDecoder().decode(buffer),
  ),
}));

vi.mock("../storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
  notifyWriteGrew: vi.fn().mockResolvedValue(undefined),
  onQuotaNear: vi.fn().mockResolvedValue([]),
}));

vi.mock("../errorReporter.ts", () => ({
  reportError: vi.fn(),
}));

function computeGeoBucket(lat: number, lon: number): string {
  return `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`;
}

function record(
  id: string,
  name: string,
  overrides?: Partial<PoiIndexRecord>,
): PoiIndexRecord {
  return {
    id,
    cityId: "gdansk",
    name,
    geoBucket: computeGeoBucket(overrides?.lat ?? 54.35, overrides?.lon ?? 18.65),
    aliases: {},
    category: "public_building",
    lat: 54.35,
    lon: 18.65,
    source: "curated",
    rankBoost: 1.0,
    tier: "strict",
    ...overrides,
  };
}

async function seedRecords(records: PoiIndexRecord[]): Promise<void> {
  await db.poiIndex.bulkPut(records);
}

describe("BundledGeocoderAdapter", () => {
  beforeEach(async () => {
    await db.poiIndex.clear();
    await db.poiSyncMeta.clear();
  });

  describe("normalizeQuery", () => {
    it("lowercases and strips diacritics", () => {
      expect(normalizeQuery("Gdańsk")).toBe("gdansk");
      expect(normalizeQuery("DWORZEC")).toBe("dworzec");
      expect(normalizeQuery("Žalgirio")).toBe("zalgirio");
    });
  });

  describe("haversineMeters", () => {
    it("returns ~0 for same point", () => {
      expect(haversineMeters(54.35, 18.65, 54.35, 18.65)).toBeLessThan(1);
    });

    it("returns reasonable distance for known points", () => {
      const d = haversineMeters(54.35, 18.65, 54.36, 18.66);
      expect(d).toBeGreaterThan(500);
      expect(d).toBeLessThan(2000);
    });
  });

  describe("forward()", () => {
    it("returns ranked candidates for prefix match within 150ms", async () => {
      await seedRecords([
        record("poi-1", "Dworzec Glowny", { rankBoost: 1.0, source: "curated" }),
        record("poi-2", "Dworzec PKP Gdynia", { rankBoost: 0.3, source: "osm" }),
        record("poi-3", "Ratusz", { rankBoost: 1.0 }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const start = performance.now();
      const results = await adapter.forward(
        "Dworz",
        { lat: 54.35, lon: 18.65 },
        new AbortController().signal,
      );
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(150);
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.provider === "bundled")).toBe(true);
      expect(results.every((r) => r.privacyTier === "local")).toBe(true);
    });

    it("ranks curated (rankBoost 1.0) above OSM (0.3) for equivalent name match", async () => {
      await seedRecords([
        record("poi-osm", "Dworzec Glowny OSM", {
          rankBoost: 0.3,
          source: "osm",
          lat: 54.355,
          lon: 18.652,
        }),
        record("poi-curated", "Dworzec Glowny Curated", {
          rankBoost: 1.0,
          source: "curated",
          lat: 54.355,
          lon: 18.652,
        }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Dworzec Glowny",
        { lat: 54.355, lon: 18.652 },
        new AbortController().signal,
      );

      expect(results.length).toBe(2);
      expect(results[0]!.confidence).toBeGreaterThan(results[1]!.confidence);
    });

    it("matches locale-specific aliases", async () => {
      await seedRecords([
        record("poi-1", "Dworzec Glowny", {
          aliases: { en: ["Main Station", "Central Station"], pl: ["Dworzec Główny"] },
        }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Main Station",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Dworzec Glowny");
    });

    it("returns empty for no matches", async () => {
      await seedRecords([record("poi-1", "Ratusz")]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Zzzzzz",
        null,
        new AbortController().signal,
      );

      expect(results).toEqual([]);
    });

    it("returns empty when no cityId", async () => {
      await seedRecords([record("poi-1", "Ratusz")]);

      const adapter = new BundledGeocoderAdapter(() => null);
      const results = await adapter.forward(
        "Ratusz",
        null,
        new AbortController().signal,
      );

      expect(results).toEqual([]);
    });

    it("respects AbortSignal", async () => {
      await seedRecords([record("poi-1", "Dworzec Glowny")]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const ctrl = new AbortController();
      ctrl.abort();

      await expect(
        adapter.forward("Dworz", null, ctrl.signal),
      ).rejects.toThrow();
    });

    it("does not return results from other cities", async () => {
      await seedRecords([
        record("poi-1", "Dworzec Glowny", { cityId: "gdansk" }),
        record("poi-2", "Dworzec Vilnius", { cityId: "vilnius" }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Dworzec",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Dworzec Glowny");
    });

    it("limits results to 10 candidates", async () => {
      const records = Array.from({ length: 20 }, (_, i) =>
        record(`poi-${i}`, `Dworzec ${i}`),
      );
      await seedRecords(records);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Dworzec",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBeLessThanOrEqual(10);
    });

    it("matches substring within name (contains match)", async () => {
      await seedRecords([
        record("poi-1", "Stary Dworzec PKP"),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Dworzec",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Stary Dworzec PKP");
    });

    it("matches a single character so users see hits immediately", async () => {
      await seedRecords([
        record("poi-1", "Gerosios vilties"),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "g",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Gerosios vilties");
    });

    it("ranks word-prefix above plain substring", async () => {
      await seedRecords([
        record("poi-word", "Gerosios vilties"),    // "vilt" → word-prefix on "vilties"
        record("poi-substr", "Stary Vilnzelis"),    // "vilt" not present
        record("poi-mid", "Ravilta park"),          // "vilt" only mid-word
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "vilt",
        null,
        new AbortController().signal,
      );

      const labels = results.map((r) => r.label);
      expect(labels).toContain("Gerosios vilties");
      expect(labels).toContain("Ravilta park");
      // Word-prefix should outrank mid-word substring
      const wordIdx = labels.indexOf("Gerosios vilties");
      const substrIdx = labels.indexOf("Ravilta park");
      expect(wordIdx).toBeLessThan(substrIdx);
    });

    it("deduplicates bundle+tile rows on same osmId; bundle wins", async () => {
      await seedRecords([
        record("poi-tile", "Museum TILE", {
          osmId: "osm-42",
          loadSource: "tile",
        }),
        record("poi-bundle", "Museum BUNDLE", {
          osmId: "osm-42",
          loadSource: "bundle",
        }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Museum",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Museum BUNDLE");
    });

    it("bundle wins even when tile record is seeded first", async () => {
      await seedRecords([
        record("poi-tile", "Cathedral TILE", {
          osmId: "osm-7",
          loadSource: "tile",
        }),
      ]);
      await seedRecords([
        record("poi-bundle", "Cathedral BUNDLE", {
          osmId: "osm-7",
          loadSource: "bundle",
        }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Cathedral",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Cathedral BUNDLE");
    });

    it("returns tile-only POIs when no bundle row exists", async () => {
      await seedRecords([
        record("poi-tile-only", "Remote Church", {
          osmId: "osm-99",
          loadSource: "tile",
        }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const results = await adapter.forward(
        "Remote",
        null,
        new AbortController().signal,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("Remote Church");
    });
  });

  describe("reverse()", () => {
    it("returns nearest POI within 500m", async () => {
      await seedRecords([
        record("poi-1", "Ratusz", { lat: 54.3520, lon: 18.6466 }),
        record("poi-2", "Dworzec Glowny", { lat: 54.3560, lon: 18.6440 }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const result = await adapter.reverse(
        { lat: 54.3521, lon: 18.6467 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result!.label).toBe("Ratusz");
      expect(result!.provider).toBe("bundled");
      expect(result!.privacyTier).toBe("local");
    });

    it("returns null when no POI within 500m", async () => {
      await seedRecords([
        record("poi-1", "Ratusz", { lat: 54.35, lon: 18.65 }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const result = await adapter.reverse(
        { lat: 55.0, lon: 19.0 },
        new AbortController().signal,
      );

      expect(result).toBeNull();
    });

    it("returns null when no cityId", async () => {
      await seedRecords([record("poi-1", "Ratusz")]);

      const adapter = new BundledGeocoderAdapter(() => null);
      const result = await adapter.reverse(
        { lat: 54.35, lon: 18.65 },
        new AbortController().signal,
      );

      expect(result).toBeNull();
    });

    it("prefers bundle row over tile row when both describe same osmId at same location", async () => {
      await seedRecords([
        record("poi-tile", "Ratusz TILE", {
          osmId: "osm-1",
          loadSource: "tile",
          lat: 54.3520,
          lon: 18.6466,
        }),
        record("poi-bundle", "Ratusz BUNDLE", {
          osmId: "osm-1",
          loadSource: "bundle",
          lat: 54.3520,
          lon: 18.6466,
        }),
      ]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const result = await adapter.reverse(
        { lat: 54.3521, lon: 18.6467 },
        new AbortController().signal,
      );

      expect(result).not.toBeNull();
      expect(result!.label).toBe("Ratusz BUNDLE");
    });

    it("respects AbortSignal for reverse", async () => {
      await seedRecords([record("poi-1", "Ratusz")]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      const ctrl = new AbortController();
      ctrl.abort();

      await expect(
        adapter.reverse({ lat: 54.35, lon: 18.65 }, ctrl.signal),
      ).rejects.toThrow();
    });
  });

  describe("isAvailable()", () => {
    it("returns true when poiIndex has entries for the city", async () => {
      await seedRecords([record("poi-1", "Ratusz")]);

      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      expect(await adapter.isAvailable()).toBe(true);
    });

    it("returns false when poiIndex is empty", async () => {
      const adapter = new BundledGeocoderAdapter(() => "gdansk");
      expect(await adapter.isAvailable()).toBe(false);
    });

    it("returns false when no cityId", async () => {
      await seedRecords([record("poi-1", "Ratusz")]);

      const adapter = new BundledGeocoderAdapter(() => null);
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe("scoreCandidate", () => {
    it("scores exact match higher than prefix match", () => {
      const exact = scoreCandidate("ratusz", "ratusz", [], null, 1.0, 54.35, 18.65);
      const prefix = scoreCandidate("ratusz", "ratusz glowny", [], null, 1.0, 54.35, 18.65);
      expect(exact).toBeGreaterThan(prefix);
    });

    it("applies rankBoost multiplier", () => {
      const high = scoreCandidate("ratusz", "ratusz", [], null, 1.0, 54.35, 18.65);
      const low = scoreCandidate("ratusz", "ratusz", [], null, 0.3, 54.35, 18.65);
      expect(high).toBeGreaterThan(low);
    });

    it("applies proximity bonus when hint is near", () => {
      const near = scoreCandidate("ratusz", "ratusz", [], { lat: 54.35, lon: 18.65 }, 1.0, 54.35, 18.65);
      const far = scoreCandidate("ratusz", "ratusz", [], { lat: 55.0, lon: 19.0 }, 1.0, 54.35, 18.65);
      expect(near).toBeGreaterThan(far);
    });
  });
});
