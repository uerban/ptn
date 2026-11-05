import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RAPTOR_DATA_VERSION } from "@pt/shared/constants";
import { PatternMode } from "@pt/shared/raptor";
import { parsePtbCatalogGeneration } from "./ptbCatalog.ts";
import { decodePtbCatalog } from "./ptbCatalogDecode.ts";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error(`ptbCatalog.test: could not locate repo root from ${process.cwd()}`);
}

const PTB = new Uint8Array(readFileSync(
  resolve(findRepoRoot(), "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb"),
));
const HASH = "a".repeat(64);
const GENERATION_ID = "b".repeat(64);

function ready(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ready",
    city: "vilnius",
    servingGenerationId: GENERATION_ID,
    generationAgeSecs: 120,
    cityTzIana: "Europe/Vilnius",
    servingShapesJsonSha256: HASH,
    servingShapesJsonSizeBytes: 42,
    nowUnixSecs: 1_800_000_000,
    patternMode: "covering-merge",
    ...overrides,
  };
}

describe("PTB catalog generation metadata", () => {
  it("derives the content-addressed shapes manifest and generation time", () => {
    const parsed = parsePtbCatalogGeneration(ready(), "vilnius");
    expect(parsed).toEqual({
      generationId: GENERATION_ID,
      bundleSha256: GENERATION_ID,
      generatedAt: new Date((1_800_000_000 - 120) * 1000).toISOString(),
      cityTzIana: "Europe/Vilnius",
      shapesArtifact: {
        url: `/api/vilnius/gtfs/shapes/shapes-${HASH}.json`,
        hash: HASH,
        sizeBytes: 42,
      },
    });
  });

  it("tracks the PTB hash separately from the publication id", () => {
    const bundleSha256 = "c".repeat(64);
    expect(parsePtbCatalogGeneration(ready({ servingBundleSha256: bundleSha256 }), "vilnius"))
      .toMatchObject({ generationId: GENERATION_ID, bundleSha256 });
    expect(() => parsePtbCatalogGeneration(ready({ servingBundleSha256: "C".repeat(64) }), "vilnius"))
      .toThrow(/invalid servingBundleSha256/);
  });

  it("accepts a generation with no shapes sidecar", () => {
    const parsed = parsePtbCatalogGeneration(ready({
      servingShapesJsonSha256: null,
      servingShapesJsonSizeBytes: null,
    }), "vilnius");
    expect(parsed.shapesArtifact).toBeUndefined();
  });

  it("fails closed on split-brain mode or incomplete shape provenance", () => {
    expect(() => parsePtbCatalogGeneration(
      ready({ patternMode: "off" }),
      "vilnius",
      PatternMode.CoveringMerge,
    )).toThrow(/pattern mode mismatch/);
    expect(() => parsePtbCatalogGeneration(
      ready({ servingShapesJsonSizeBytes: undefined }),
      "vilnius",
    )).toThrow(/incomplete shapes provenance/);
  });
});

describe("decodePtbCatalog", () => {
  it("decodes a plain Uint8Array into the existing catalog schema", () => {
    const generation = parsePtbCatalogGeneration(ready(), "vilnius");
    const catalog = decodePtbCatalog(PTB, {
      cityId: "vilnius",
      generation,
      patternMode: PatternMode.Off,
      transfersArtifact: {
        url: "/api/vilnius/transfers/fetch",
        hash: "c".repeat(64),
        sizeBytes: 12,
      },
    });

    expect(catalog.version).toBe(RAPTOR_DATA_VERSION);
    expect(catalog.stops.length).toBeGreaterThan(0);
    expect(catalog.routes.length).toBeGreaterThan(0);
    expect(catalog.meta).toMatchObject({
      cityId: "vilnius",
      cityTzIana: "Europe/Vilnius",
      generatedAt: generation.generatedAt,
      shapesArtifact: generation.shapesArtifact,
      transfersArtifact: { sizeBytes: 12 },
    });
  });
});
