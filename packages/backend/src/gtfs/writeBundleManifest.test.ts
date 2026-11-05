import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundleManifest } from "./writeBundleManifest.js";
import type { BundleManifest } from "@pt/shared";

describe("writeBundleManifest", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-mani-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("writes a JSON file matching the BundleManifest type", () => {
    writeBundleManifest({ dataDir, bundleHash: "abc", generatedAt: 1700000000000, tileSize: 12000 });

    const text = readFileSync(join(dataDir, "manifest.json"), "utf8");
    const parsed: BundleManifest = JSON.parse(text);
    expect(parsed.bundleHash).toBe("abc");
    expect(parsed.generatedAt).toBe(1700000000000);
    expect(parsed.tileSize).toBe(12000);
  });

  it("overwrites an existing manifest atomically (no half-written state)", () => {
    writeBundleManifest({ dataDir, bundleHash: "first", generatedAt: 100, tileSize: 12000 });
    writeBundleManifest({ dataDir, bundleHash: "second", generatedAt: 200, tileSize: 12000 });

    const parsed: BundleManifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
    expect(parsed.bundleHash).toBe("second");
    expect(parsed.generatedAt).toBe(200);

    expect(() => statSync(join(dataDir, "manifest.json.tmp"))).toThrow();
  });

  it("writes schemaVersion and an optional subdivisions plan that JSON-round-trips", () => {
    const subdivisions = {
      "906_28": {
        leaves: [
          { suffix: "0", bbox: { minLat: 48.1, maxLat: 48.2, minLon: 2.3, maxLon: 2.35 }, compressedBytes: 1234, oversized: false },
          { suffix: "3", bbox: { minLat: 48.2, maxLat: 48.3, minLon: 2.35, maxLon: 2.4 }, compressedBytes: 5678, oversized: true },
        ],
      },
    };
    writeBundleManifest({ dataDir, bundleHash: "abc", generatedAt: 1700000000000, tileSize: 6000, subdivisions });

    const parsed: BundleManifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.subdivisions!["906_28"]!.leaves).toHaveLength(2);
    expect(parsed.subdivisions!["906_28"]!.leaves[1]!.oversized).toBe(true);
    expect(parsed.subdivisions!["906_28"]!.leaves[0]!.bbox).toEqual({ minLat: 48.1, maxLat: 48.2, minLon: 2.3, maxLon: 2.35 });
  });

  it("omits subdivisions when none are passed but still sets schemaVersion (old-reader tolerance)", () => {
    writeBundleManifest({ dataDir, bundleHash: "abc", generatedAt: 1, tileSize: 6000 });
    const parsed: BundleManifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.subdivisions).toBeUndefined();
    // Old readers that only read bundleHash/generatedAt/tileSize are unaffected.
    expect(parsed.bundleHash).toBe("abc");
  });
});
