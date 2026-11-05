import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type LandmarkCityId,
  type LandmarkFile,
  summarizeLandmarkFile,
  validateLandmarkFile,
} from "./landmarksSchema.js";

const DATA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test-fixtures",
  "landmarks",
);

// Tbilisi is OSM-only; these are the cities with reviewed curated files.
const CURATED_CITY_IDS = ["gdansk", "gdynia", "sopot", "vilnius"] as const;

function loadRaw(cityId: LandmarkCityId): unknown {
  const text = readFileSync(resolve(DATA_DIR, `${cityId}.json`), "utf-8");
  return JSON.parse(text);
}

function loadValid(cityId: LandmarkCityId): LandmarkFile {
  const result = validateLandmarkFile(loadRaw(cityId), { expectedCity: cityId });
  if (!result.ok) {
    throw new Error(
      `precondition: ${cityId}.json is expected to be valid, got: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.value;
}

describe("validateLandmarkFile — curated data files", () => {
  for (const cityId of CURATED_CITY_IDS) {
    it(`validates ${cityId}.json`, () => {
      const result = validateLandmarkFile(loadRaw(cityId), { expectedCity: cityId });
      if (!result.ok) {
        // Surface the full issue list so CI logs show what failed.
        throw new Error(
          `validation failures in ${cityId}.json:\n${result.issues
            .map((i) => `  ${i.path}: ${i.message}`)
            .join("\n")}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});

describe("summarizeLandmarkFile", () => {
  it("surfaces needsNativeReview count matching _meta", () => {
    for (const cityId of CURATED_CITY_IDS) {
      const raw = loadRaw(cityId) as {
        _meta: { needsReviewCount: number; entryCount: number };
      };
      const file = loadValid(cityId);
      const summary = summarizeLandmarkFile(file);
      expect(summary.cityId).toBe(cityId);
      expect(summary.entryCount).toBe(raw._meta.entryCount);
      expect(summary.needsNativeReviewCount).toBe(raw._meta.needsReviewCount);
    }
  });

  it("produces category counts that sum to entry count", () => {
    const file = loadValid("gdansk");
    const summary = summarizeLandmarkFile(file);
    const total = Object.values(summary.categoryCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(summary.entryCount);
  });
});

describe("validateLandmarkFile — rejections", () => {
  function baseEntry() {
    return {
      id: "tst-1",
      city: "gdansk",
      canonicalName: "Test",
      aliases: { en: ["Test"] },
      category: "landmark",
      lat: 54.35,
      lon: 18.65,
      bbox: [54.34, 18.64, 54.36, 18.66],
      nearestStopGroupId: null,
      source: "curated",
      sourceVersion: "2026-04-13",
      needsNativeReview: false,
    };
  }

  function baseFile(entries: unknown[] = [baseEntry()]) {
    return {
      _meta: {
        generated: "2026-04-13",
        sourceVersion: "2026-04-13",
        entryCount: entries.length,
        needsReviewCount: 0,
      },
      entries,
    };
  }

  it("rejects non-object root", () => {
    const result = validateLandmarkFile(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("$");
    }
  });

  it("rejects missing _meta", () => {
    const f = baseFile();
    // @ts-expect-error intentionally stripping _meta
    delete f._meta;
    const result = validateLandmarkFile(f);
    expect(result.ok).toBe(false);
  });

  it("rejects bad category", () => {
    const entry = baseEntry();
    entry.category = "not_a_category";
    const result = validateLandmarkFile(baseFile([entry]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.endsWith(".category"))).toBe(true);
    }
  });

  it("rejects out-of-range lat", () => {
    const entry = baseEntry();
    entry.lat = 120;
    const result = validateLandmarkFile(baseFile([entry]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.endsWith(".lat"))).toBe(true);
    }
  });

  it("rejects point outside its own bbox", () => {
    const entry = baseEntry();
    entry.lat = 54.5; // bbox max is 54.36
    const result = validateLandmarkFile(baseFile([entry]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.endsWith(".bbox"))).toBe(true);
    }
  });

  it("rejects city mismatch against expectedCity", () => {
    const entry = baseEntry();
    entry.city = "gdansk";
    const result = validateLandmarkFile(baseFile([entry]), { expectedCity: "sopot" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.endsWith(".city"))).toBe(true);
    }
  });

  it("rejects duplicate ids", () => {
    const result = validateLandmarkFile(baseFile([baseEntry(), baseEntry()]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes("duplicate id"))).toBe(true);
    }
  });

  it("rejects wrong _meta.entryCount", () => {
    const f = baseFile([baseEntry()]);
    f._meta.entryCount = 99;
    const result = validateLandmarkFile(f);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === "_meta.entryCount")).toBe(true);
    }
  });

  it("rejects wrong _meta.needsReviewCount", () => {
    const entry = baseEntry();
    entry.needsNativeReview = true;
    const f = baseFile([entry]);
    f._meta.needsReviewCount = 0;
    const result = validateLandmarkFile(f);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === "_meta.needsReviewCount")).toBe(true);
    }
  });

  it("rejects malformed wikidataId", () => {
    const entry = baseEntry() as Record<string, unknown>;
    entry.wikidataId = "not-a-q-id";
    const result = validateLandmarkFile(baseFile([entry]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.endsWith(".wikidataId"))).toBe(true);
    }
  });

  it("rejects unknown alias language", () => {
    const entry = baseEntry() as Record<string, unknown>;
    entry.aliases = { zz: ["bad"] };
    const result = validateLandmarkFile(baseFile([entry]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes("unknown language"))).toBe(true);
    }
  });

  it("rejects empty alias string", () => {
    const entry = baseEntry() as Record<string, unknown>;
    entry.aliases = { en: [""] };
    const result = validateLandmarkFile(baseFile([entry]));
    expect(result.ok).toBe(false);
  });

  it("accepts minimal valid file", () => {
    const result = validateLandmarkFile(baseFile());
    expect(result.ok).toBe(true);
  });
});
