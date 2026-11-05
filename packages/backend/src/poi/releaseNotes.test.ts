import { describe, it, expect } from "vitest";
import { brotliCompressSync } from "node:zlib";
import {
  parseBundleFilename,
  readBundleFromBuffer,
  formatReleaseBody,
  type BundleSummary,
} from "./releaseNotes.js";
import type { PoiBundle } from "@pt/shared";

function makeFakeBundle(overrides: Partial<PoiBundle["meta"]> = {}): PoiBundle {
  return {
    meta: {
      cityId: "gdansk",
      version: "abc123",
      attribution: "\u00a9 OpenStreetMap contributors",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      sourcePbfTimestamp: "2026-04-10T00:00:00Z",
      bundleGeneratedAt: "2026-04-13T12:00:00Z",
      tier: "strict",
      entryCount: 42,
      ...overrides,
    },
    entries: [],
  };
}

function compressBundle(bundle: PoiBundle): Buffer {
  return brotliCompressSync(Buffer.from(JSON.stringify(bundle)));
}

describe("parseBundleFilename", () => {
  it("parses strict tier filename", () => {
    expect(parseBundleFilename("gdansk.br")).toEqual({
      cityId: "gdansk",
      tier: "strict",
    });
  });

  it("parses loose tier filename", () => {
    expect(parseBundleFilename("vilnius.loose.br")).toEqual({
      cityId: "vilnius",
      tier: "loose",
    });
  });

  it("returns null for non-bundle files", () => {
    expect(parseBundleFilename("readme.md")).toBeNull();
    expect(parseBundleFilename("data.json")).toBeNull();
    expect(parseBundleFilename(".br")).toBeNull();
  });
});

describe("readBundleFromBuffer", () => {
  it("decompresses and parses a Brotli bundle", () => {
    const bundle = makeFakeBundle({ cityId: "sopot", entryCount: 5 });
    const compressed = compressBundle(bundle);
    const result = readBundleFromBuffer(compressed);
    expect(result.meta.cityId).toBe("sopot");
    expect(result.meta.entryCount).toBe(5);
    expect(result.meta.attribution).toBe("\u00a9 OpenStreetMap contributors");
  });
});

describe("formatReleaseBody", () => {
  const summaries: BundleSummary[] = [
    {
      cityId: "gdansk",
      tier: "strict",
      entryCount: 120,
      version: "aaa111",
      sourcePbfTimestamp: "2026-04-10T00:00:00Z",
      bundleGeneratedAt: "2026-04-13T12:00:00Z",
      filename: "gdansk.br",
    },
    {
      cityId: "gdansk",
      tier: "loose",
      entryCount: 5000,
      version: "bbb222",
      sourcePbfTimestamp: "2026-04-10T00:00:00Z",
      bundleGeneratedAt: "2026-04-13T12:00:00Z",
      filename: "gdansk.loose.br",
    },
    {
      cityId: "vilnius",
      tier: "strict",
      entryCount: 80,
      version: "ccc333",
      sourcePbfTimestamp: "2026-04-11T00:00:00Z",
      bundleGeneratedAt: "2026-04-13T12:00:00Z",
      filename: "vilnius.br",
    },
  ];

  it("includes POI Bundles header", () => {
    const body = formatReleaseBody(summaries);
    expect(body).toContain("## POI Bundles");
  });

  it("includes a table with all cities and tiers", () => {
    const body = formatReleaseBody(summaries);
    expect(body).toContain("| gdansk | strict | 120 | aaa111 |");
    expect(body).toContain("| gdansk | loose | 5000 | bbb222 |");
    expect(body).toContain("| vilnius | strict | 80 | ccc333 |");
  });

  it("includes source PBF timestamps", () => {
    const body = formatReleaseBody(summaries);
    expect(body).toContain("### Source PBF Timestamps");
    expect(body).toContain("2026-04-10T00:00:00Z");
    expect(body).toContain("2026-04-11T00:00:00Z");
  });

  it("includes bundle generation timestamp", () => {
    const body = formatReleaseBody(summaries);
    expect(body).toContain("Bundles generated at: 2026-04-13T12:00:00Z");
  });

  it("includes ODbL attribution with link", () => {
    const body = formatReleaseBody(summaries);
    expect(body).toContain(
      "Map data \u00a9 OpenStreetMap contributors",
    );
    expect(body).toContain("opendatacommons.org/licenses/odbl");
    expect(body).toContain("openstreetmap.org/copyright");
  });

  it("handles empty summaries without crashing", () => {
    const body = formatReleaseBody([]);
    expect(body).toContain("## POI Bundles");
    expect(body).toContain("### Attribution");
    expect(body).not.toContain("Bundles generated at:");
  });

  it("deduplicates PBF timestamps", () => {
    const body = formatReleaseBody(summaries);
    const matches = body.match(/2026-04-10T00:00:00Z/g);
    expect(matches).toHaveLength(1);
  });
});
