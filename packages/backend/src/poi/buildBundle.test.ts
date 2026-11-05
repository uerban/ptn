import { describe, it, expect, vi } from "vitest";
import { brotliDecompressSync } from "node:zlib";
import type { LandmarkEntry } from "@pt/shared";
import type { CategorizedOsmFeature } from "./osmiumExtract.js";
import { filterFeatures } from "./osmiumExtract.js";
import { loadTagSpec } from "./osmTags.js";
import {
  fixtureFeatures,
  fixtureExpectedStrictCounts,
} from "./__fixtures__/osmFixture.js";
import {
  normalizeName,
  curatedToPoiEntry,
  osmToPoiEntry,
  mergeEntries,
  osmRankBoost,
  contentHash,
  createBundle,
  compressBundle,
  buildCityBundle,
  validateTileKAnonymity,
  assertTilesMeetK,
  TileKAnonymityViolation,
  type PoiEntry,
  type PoiBundle,
} from "./buildBundle.js";
import type { TileAnchor } from "@pt/shared";

const spec = loadTagSpec();

function makeLandmark(overrides: Partial<LandmarkEntry> = {}): LandmarkEntry {
  return {
    id: "test-landmark",
    city: "gdansk",
    canonicalName: "Test Landmark",
    aliases: { pl: ["Test PL"], en: ["Test EN"] },
    category: "landmark",
    lat: 54.35,
    lon: 18.65,
    bbox: [54.34, 18.64, 54.36, 18.66] as const,
    nearestStopGroupId: null,
    source: "curated",
    sourceVersion: "2026-04-13",
    needsNativeReview: false,
    ...overrides,
  };
}

function makeOsmFeature(
  overrides: Partial<CategorizedOsmFeature> = {},
): CategorizedOsmFeature {
  return {
    id: "100",
    type: "node",
    lat: 54.35,
    lon: 18.65,
    tags: { name: "OSM Place", "name:en": "OSM Place EN" },
    tier: "strict",
    category: "transit_entrance",
    ...overrides,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("normalizeName", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeName("Gdańsk Główny")).toBe("gdansk glowny");
  });

  it("collapses whitespace", () => {
    expect(normalizeName("  Targ   Węglowy  ")).toBe("targ weglowy");
  });

  it("handles empty string", () => {
    expect(normalizeName("")).toBe("");
  });

  it("handles pure ASCII", () => {
    expect(normalizeName("Main Station")).toBe("main station");
  });
});

describe("curatedToPoiEntry", () => {
  it("converts a landmark entry with all fields", () => {
    const landmark = makeLandmark({ wikidataId: "Q12345" });
    const poi = curatedToPoiEntry(landmark);

    expect(poi.id).toBe("test-landmark");
    expect(poi.name).toBe("Test Landmark");
    expect(poi.source).toBe("curated");
    expect(poi.rankBoost).toBe(1.0);
    expect(poi.wikidataId).toBe("Q12345");
    expect(poi.tier).toBe("strict");
    expect(poi.aliases).toEqual({ pl: ["Test PL"], en: ["Test EN"] });
  });

  it("omits wikidataId when absent", () => {
    const poi = curatedToPoiEntry(makeLandmark());
    expect(poi).not.toHaveProperty("wikidataId");
  });

  it("preserves nearestStopGroupId null", () => {
    const poi = curatedToPoiEntry(makeLandmark());
    expect(poi.nearestStopGroupId).toBeNull();
  });
});

describe("osmToPoiEntry", () => {
  it("retains romanized names and optional mapped address context", () => {
    const poi = osmToPoiEntry(makeOsmFeature({ tags: {
      name: "ვარკეთილი", "name:ka-Latn": "Vark’etili",
      "name:etymology": "Not a display name", "name:en:pronunciation": "Not a display name",
      "addr:street": " Rustaveli Ave ", "addr:housenumber": "2/4",
      "addr:suburb": "Mtatsminda", "addr:city": "Tbilisi",
    } }));
    expect(poi.aliases).toEqual({ "ka-Latn": ["Vark’etili"] });
    expect(poi.address).toEqual({ street: "Rustaveli Ave", houseNumber: "2/4", locality: "Mtatsminda" });
    expect(osmToPoiEntry(makeOsmFeature())).not.toHaveProperty("address");
  });
  it("supplements curated destinations with OSM address context", () => {
    const curated = curatedToPoiEntry(makeLandmark({ wikidataId: "Q1" }));
    const osm = osmToPoiEntry(makeOsmFeature({ tags: { name: "Test", wikidata: "Q1", "addr:city": "Tbilisi" } }));
    expect(mergeEntries([curated], [osm])[0].address).toEqual({ locality: "Tbilisi" });
    expect(curated).not.toHaveProperty("address");
  });

  it("keeps one address intact when multiple OSM features match a landmark", () => {
    const curated = curatedToPoiEntry(makeLandmark({ wikidataId: "Q1" }));
    const first = osmToPoiEntry(makeOsmFeature({ id: "1", tags: {
      name: "First entrance", wikidata: "Q1", "addr:street": "Station Road",
    } }));
    const second = osmToPoiEntry(makeOsmFeature({ id: "2", tags: {
      name: "Second entrance", wikidata: "Q1", "addr:street": "Market Street", "addr:housenumber": "12",
    } }));
    expect(mergeEntries([curated], [first, second])[0].address).toEqual({ street: "Station Road" });
    const withAddress = { ...curated, address: { street: "Curated Road", houseNumber: "9" } };
    expect(mergeEntries([withAddress], [first, second])[0].address).toEqual(withAddress.address);
  });

  it("keeps legacy underscore language aliases and ignores blank suburbs", () => {
    const poi = osmToPoiEntry(makeOsmFeature({ tags: {
      name: "Place", "name:zh_pinyin": "Mapped name", "addr:suburb": "  ", "addr:city": "Tbilisi",
    } }));
    expect(poi.aliases).toEqual({ zh_pinyin: ["Mapped name"] });
    expect(poi.address).toEqual({ locality: "Tbilisi" });
  });

  it("converts an OSM feature with name tags", () => {
    const feature = makeOsmFeature({
      tags: {
        name: "Gdańsk Główny",
        "name:en": "Gdansk Central",
        "name:de": "Danzig Hbf",
        wikidata: "Q800296",
      },
    });
    const poi = osmToPoiEntry(feature);

    expect(poi.id).toBe("osm-100");
    expect(poi.name).toBe("Gdańsk Główny");
    expect(poi.source).toBe("osm");
    expect(poi.rankBoost).toBe(0.3);
    expect(poi.osmId).toBe("100");
    expect(poi.wikidataId).toBe("Q800296");
    expect(poi.aliases).toEqual({ en: ["Gdansk Central"], de: ["Danzig Hbf"] });
  });

  it("handles feature without wikidata tag", () => {
    const poi = osmToPoiEntry(makeOsmFeature());
    expect(poi).not.toHaveProperty("wikidataId");
  });
});

describe("mergeEntries", () => {
  it("returns curated entries when no OSM entries", () => {
    const curated = [curatedToPoiEntry(makeLandmark())];
    const result = mergeEntries(curated, []);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("curated");
  });

  it("adds unmatched OSM entries after curated", () => {
    const curated = [curatedToPoiEntry(makeLandmark())];
    const osm = [osmToPoiEntry(makeOsmFeature({ id: "200" }))];
    const result = mergeEntries(curated, osm);
    expect(result).toHaveLength(2);
    expect(result[0].source).toBe("curated");
    expect(result[1].source).toBe("osm");
  });

  it("matches by wikidataId and supplements aliases", () => {
    const landmark = makeLandmark({
      wikidataId: "Q800296",
      aliases: { pl: ["Dworzec PL"] },
    });
    const curated = [curatedToPoiEntry(landmark)];
    const osm = [
      osmToPoiEntry(
        makeOsmFeature({
          tags: {
            name: "Different Name",
            "name:de": "Danzig Hbf",
            wikidata: "Q800296",
          },
        }),
      ),
    ];
    const result = mergeEntries(curated, osm);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("curated");
    expect(result[0].aliases.pl).toEqual(["Dworzec PL"]);
    expect(result[0].aliases.de).toEqual(["Danzig Hbf"]);
  });

  it("does not overwrite existing aliases from curated", () => {
    const landmark = makeLandmark({
      wikidataId: "Q800296",
      aliases: { en: ["Curated EN"] },
    });
    const curated = [curatedToPoiEntry(landmark)];
    const osm = [
      osmToPoiEntry(
        makeOsmFeature({
          tags: { name: "X", "name:en": "OSM EN", wikidata: "Q800296" },
        }),
      ),
    ];
    const result = mergeEntries(curated, osm);

    expect(result[0].aliases.en).toEqual(["Curated EN"]);
  });

  it("matches by normalized name when wikidataId is absent", () => {
    const landmark = makeLandmark({
      canonicalName: "Gdańsk Główny",
      aliases: { pl: ["Dworzec"] },
    });
    const curated = [curatedToPoiEntry(landmark)];
    const osm = [
      osmToPoiEntry(
        makeOsmFeature({
          tags: { name: "Gdansk Glowny", "name:ru": "Гданьск Главный" },
        }),
      ),
    ];
    const result = mergeEntries(curated, osm);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("curated");
    expect(result[0].aliases.ru).toEqual(["Гданьск Главный"]);
  });

  it("deduplicates OSM entries by osmId", () => {
    const osm = [
      osmToPoiEntry(makeOsmFeature({ id: "300", tags: { name: "Place A" } })),
      osmToPoiEntry(makeOsmFeature({ id: "300", tags: { name: "Place A v2" } })),
    ];
    const result = mergeEntries([], osm);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Place A");
  });

  it("keeps curated fields when OSM matches by name", () => {
    const landmark = makeLandmark({
      canonicalName: "Politechnika Gdańska",
      category: "university",
    });
    const curated = [curatedToPoiEntry(landmark)];
    const osm = [
      osmToPoiEntry(
        makeOsmFeature({
          tags: { name: "Politechnika Gdańska" },
          category: "public_building",
        }),
      ),
    ];
    const result = mergeEntries(curated, osm);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("university");
    expect(result[0].source).toBe("curated");
    expect(result[0].rankBoost).toBe(1.0);
  });
});

describe("contentHash", () => {
  it("returns a 16-char hex string", () => {
    const entries = [curatedToPoiEntry(makeLandmark())];
    const hash = contentHash(entries);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic for the same input", () => {
    const entries = [curatedToPoiEntry(makeLandmark())];
    expect(contentHash(entries)).toBe(contentHash(entries));
  });

  it("changes when entries change", () => {
    const a = [curatedToPoiEntry(makeLandmark({ id: "a" }))];
    const b = [curatedToPoiEntry(makeLandmark({ id: "b" }))];
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});

describe("createBundle", () => {
  it("produces a valid PoiBundle", () => {
    const entries = [curatedToPoiEntry(makeLandmark())];
    const bundle = createBundle("gdansk", "strict", entries, {
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
    });

    expect(bundle.meta.cityId).toBe("gdansk");
    expect(bundle.meta.tier).toBe("strict");
    expect(bundle.meta.entryCount).toBe(1);
    expect(bundle.meta.version).toMatch(/^[a-f0-9]{16}$/);
    expect(bundle.meta.attribution).toContain("OpenStreetMap");
    expect(bundle.meta.licenseUrl).toContain("odbl");
    expect(bundle.entries).toHaveLength(1);
  });
});

describe("compressBundle", () => {
  it("produces valid Brotli that decompresses to the bundle JSON", () => {
    const entries = [curatedToPoiEntry(makeLandmark())];
    const bundle = createBundle("gdansk", "strict", entries, {
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
    });
    const compressed = compressBundle(bundle);
    expect(Buffer.isBuffer(compressed)).toBe(true);
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.length).toBeLessThan(JSON.stringify(bundle).length);

    const decompressed = JSON.parse(
      brotliDecompressSync(compressed).toString("utf-8"),
    ) as PoiBundle;
    expect(decompressed.meta.cityId).toBe("gdansk");
    expect(decompressed.entries).toHaveLength(1);
  });
});

describe("validateTileKAnonymity", () => {
  function cluster(n: number, lat: number, lon: number): PoiEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `e-${lat}-${lon}-${i}`,
      name: `Entry ${i}`,
      aliases: {},
      category: "landmark",
      lat: lat + i * 1e-6,
      lon: lon + i * 1e-6,
      source: "curated" as const,
      rankBoost: 1.0,
      nearestStopGroupId: null,
      tier: "strict" as const,
    }));
  }

  it("is a no-op for zero entries", () => {
    expect(() => validateTileKAnonymity("gdansk", [])).not.toThrow();
  });

  it("throws a whole-bundle violation when the whole bundle has fewer than k entries", () => {
    // 49 total across the city → the shipped unit (whole bundle) is sub-k.
    try {
      validateTileKAnonymity("gdansk", cluster(49, 54.35, 18.65));
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TileKAnonymityViolation);
      const v = err as TileKAnonymityViolation;
      expect(v.cityId).toBe("gdansk");
      expect(v.violations).toHaveLength(1);
      expect(v.violations[0]!.tileKey).toBe("gdansk/whole-bundle");
      expect(v.violations[0]!.count).toBe(49);
    }
  });

  it("accepts a whole bundle with 50 entries", () => {
    expect(() =>
      validateTileKAnonymity("gdansk", cluster(50, 54.35, 18.65)),
    ).not.toThrow();
  });

  it("warns but does not throw on sub-k per-tile slices when the whole bundle meets k", () => {
    // 60 total (>= k) but the second cluster (10) lands in its own sub-k tile.
    // Per-tile delivery is dormant, so this is a warning, not a violation.
    const entries = [
      ...cluster(50, 54.35, 18.65),
      ...cluster(10, 54.55, 18.95),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => validateTileKAnonymity("gdansk", entries)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("per-tile slice(s) below k=50");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("buildCityBundle", () => {
  it("produces a deterministic bundle from curated-only input", async () => {
    const landmarks = [
      makeLandmark({ id: "a", canonicalName: "Alpha" }),
      makeLandmark({ id: "b", canonicalName: "Beta" }),
    ];
    const { bundle } = await buildCityBundle("gdansk", {
      tagSpec: spec,
      tier: "strict",
      landmarkEntries: landmarks,
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
      skipKAnonymityValidation: true,
    });

    expect(bundle.entries).toHaveLength(2);
    expect(bundle.entries[0].name).toBe("Alpha");
    expect(bundle.entries[1].name).toBe("Beta");
    expect(bundle.meta.entryCount).toBe(2);
  });

  it("filters landmarks by cityId", async () => {
    const landmarks = [
      makeLandmark({ id: "gd", city: "gdansk" }),
      makeLandmark({ id: "sp", city: "sopot" }),
    ];
    const { bundle } = await buildCityBundle("gdansk", {
      tagSpec: spec,
      tier: "strict",
      landmarkEntries: landmarks,
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
      skipKAnonymityValidation: true,
    });

    expect(bundle.entries).toHaveLength(1);
    expect(bundle.entries[0].id).toBe("gd");
  });

  it("merges OSM features with curated landmarks", async () => {
    const landmarks = [
      makeLandmark({
        id: "uni",
        canonicalName: "Uniwersytet Gdański",
        wikidataId: "Q1000",
        category: "university",
      }),
    ];

    const osmFeatures: CategorizedOsmFeature[] = [
      {
        id: "999",
        type: "node",
        lat: 54.35,
        lon: 18.65,
        tags: { name: "Uniwersytet Gdański", wikidata: "Q1000", "name:en": "University of Gdansk" },
        tier: "strict",
        category: "public_building",
      },
      {
        id: "998",
        type: "node",
        lat: 54.36,
        lon: 18.66,
        tags: { name: "Nowy Ratusz" },
        tier: "strict",
        category: "public_building",
      },
    ];

    const { bundle } = await buildCityBundle("gdansk", {
      tagSpec: spec,
      tier: "strict",
      landmarkEntries: landmarks,
      osmFeatures,
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
      skipKAnonymityValidation: true,
    });

    expect(bundle.entries).toHaveLength(2);
    const uni = bundle.entries[0];
    expect(uni.source).toBe("curated");
    expect(uni.category).toBe("university");
    expect(uni.rankBoost).toBe(1.0);
    expect(uni.aliases.en).toEqual(["Test EN"]);

    const ratusz = bundle.entries[1];
    expect(ratusz.source).toBe("osm");
    expect(ratusz.rankBoost).toBe(0.3);
  });

  it("integrates with osmium fixture features via filterFeatures", async () => {
    const landmarks = [
      makeLandmark({
        id: "gdansk-glowny",
        canonicalName: "Gdańsk Główny",
        category: "train_station",
      }),
    ];

    const filtered = filterFeatures(fixtureFeatures, spec, "strict");

    const { bundle } = await buildCityBundle("gdansk", {
      tagSpec: spec,
      tier: "strict",
      landmarkEntries: landmarks,
      osmFeatures: filtered,
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
      skipKAnonymityValidation: true,
    });

    const totalStrict = Object.values(fixtureExpectedStrictCounts).reduce(
      (a, b) => a + b,
      0,
    );
    expect(bundle.entries.length).toBeGreaterThanOrEqual(1);
    expect(bundle.entries.length).toBeLessThanOrEqual(totalStrict + 1);

    const gdanskGlowny = bundle.entries.find(
      (e) => e.id === "gdansk-glowny",
    );
    expect(gdanskGlowny).toBeDefined();
    expect(gdanskGlowny!.source).toBe("curated");
    expect(gdanskGlowny!.category).toBe("train_station");
  });

  it("throws TileKAnonymityViolation when a single tile has 49 POIs", async () => {
    const landmarks: LandmarkEntry[] = Array.from({ length: 49 }, (_, i) =>
      makeLandmark({
        id: `cluster-${i}`,
        canonicalName: `Cluster ${i}`,
        lat: 54.35 + i * 1e-5,
        lon: 18.65 + i * 1e-5,
      }),
    );

    await expect(
      buildCityBundle("gdansk", {
        tagSpec: spec,
        tier: "strict",
        landmarkEntries: landmarks,
        sourcePbfTimestamp: "2026-04-13T00:00:00Z",
        bundleGeneratedAt: "2026-04-14T00:00:00Z",
      }),
    ).rejects.toBeInstanceOf(TileKAnonymityViolation);
  });

  it("passes when a single tile has 50 POIs", async () => {
    const landmarks: LandmarkEntry[] = Array.from({ length: 50 }, (_, i) =>
      makeLandmark({
        id: `cluster-${i}`,
        canonicalName: `Cluster ${i}`,
        lat: 54.35 + i * 1e-5,
        lon: 18.65 + i * 1e-5,
      }),
    );

    const { bundle } = await buildCityBundle("gdansk", {
      tagSpec: spec,
      tier: "strict",
      landmarkEntries: landmarks,
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
    });
    expect(bundle.entries).toHaveLength(50);
  });

  it("compressed output round-trips correctly", async () => {
    const landmarks = [makeLandmark()];
    const { bundle, compressed } = await buildCityBundle("gdansk", {
      tagSpec: spec,
      tier: "strict",
      landmarkEntries: landmarks,
      sourcePbfTimestamp: "2026-04-13T00:00:00Z",
      bundleGeneratedAt: "2026-04-14T00:00:00Z",
      skipKAnonymityValidation: true,
    });

    const roundTrip = JSON.parse(
      brotliDecompressSync(compressed).toString("utf-8"),
    ) as PoiBundle;
    expect(roundTrip).toEqual(bundle);
  });
});

describe("assertTilesMeetK (k-anon-floor, derived edge)", () => {
  const anchor: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
  function cluster(n: number, lat: number, lon: number): PoiEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `e-${lat}-${lon}-${i}`, name: `Entry ${i}`, aliases: {},
      category: "landmark", lat: lat + i * 1e-6, lon: lon + i * 1e-6,
      source: "curated" as const, rankBoost: 1.0, tier: "strict" as const,
    }));
  }
  it("passes when every tile at the edge is >= k", () => {
    expect(() => assertTilesMeetK("gdansk", cluster(60, 54.35, 18.65), 24, anchor)).not.toThrow();
  });
  it("throws naming the sub-k tile", () => {
    const entries = [...cluster(60, 54.30, 18.42), ...cluster(10, 54.44, 18.73)];
    expect(() => assertTilesMeetK("gdansk", entries, 12, anchor)).toThrow(/TileKAnonymityViolation|below k/i);
  });
});

describe("osmRankBoost", () => {
  const loose = (tags: Record<string, string>, category: string) =>
    makeOsmFeature({ tags: { name: "X", ...tags }, tier: "loose", category });

  it("ranks malls above hotels, kindergartens and OSM bus stops", () => {
    const mall = osmRankBoost(loose({ shop: "mall" }, "retail"));
    const museum = osmRankBoost(loose({ tourism: "museum" }, "tourism"));
    expect(mall).toBeGreaterThan(museum);
    for (const f of [
      loose({ tourism: "hotel" }, "tourism"),
      loose({ tourism: "hostel" }, "tourism"),
      loose({ tourism: "guest_house" }, "tourism"),
      loose({ amenity: "kindergarten" }, "school"),
      loose({ highway: "bus_stop" }, "named_bus_stop"),
    ]) {
      expect(osmRankBoost(f)).toBeLessThan(museum);
    }
  });

  it("puts Galleria Tbilisi above a Tbilisi hotel for the query 'tbilisi'", () => {
    // Mirrors the client scorer: alias word-prefix 0.6 vs name prefix 0.85.
    const mall = 0.6 * osmRankBoost(loose({ shop: "mall" }, "retail"));
    const hotel = 0.85 * osmRankBoost(loose({ tourism: "hotel" }, "tourism"));
    const attraction = 0.85 * osmRankBoost(loose({ tourism: "attraction" }, "tourism"));
    expect(mall).toBeGreaterThan(hotel);
    expect(mall).toBeGreaterThan(attraction);
  });
});

