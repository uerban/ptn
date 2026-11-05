import { describe, it, expect } from "vitest";
import { writeManifest, type BundleEntry } from "../../src/poi/manifest.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "poi-manifest-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writeManifest", () => {
  it("emits sha256 hashes per city bundle and returns the manifest", () => {
    withTmpDir((dir) => {
      const vilniusBytes = Buffer.from("vilnius-fixture");
      writeFileSync(join(dir, "vilnius.br"), vilniusBytes);
      const entries: BundleEntry[] = [
        { cityId: "vilnius", filename: "vilnius.br", sizeBytes: vilniusBytes.length },
      ];

      const returned = writeManifest(dir, entries, () => 1234567890);

      const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const expectedHash = createHash("sha256").update(vilniusBytes).digest("hex");

      // Returned manifest matches what was written to disk.
      expect(returned).toEqual(onDisk);
      expect(returned.generatedAt).toBe(1234567890);
      expect(returned.bundles).toHaveLength(1);
      expect(returned.bundles[0]).toMatchObject({
        cityId: "vilnius",
        filename: "vilnius.br",
        sha256: expectedHash,
        sizeBytes: vilniusBytes.length,
      });
    });
  });

  it("sorts bundles by (cityId, filename) for diff stability", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "vilnius.br"), Buffer.from("v"));
      writeFileSync(join(dir, "gdansk.br"), Buffer.from("g"));
      writeFileSync(join(dir, "sopot.br"), Buffer.from("s"));
      const entries: BundleEntry[] = [
        { cityId: "vilnius", filename: "vilnius.br", sizeBytes: 1 },
        { cityId: "gdansk", filename: "gdansk.br", sizeBytes: 1 },
        { cityId: "sopot", filename: "sopot.br", sizeBytes: 1 },
      ];

      const manifest = writeManifest(dir, entries, () => 0);
      const cityIds = manifest.bundles.map((b) => b.cityId);
      expect(cityIds).toEqual(["gdansk", "sopot", "vilnius"]);
    });
  });

  it("emits identical hashes for identical bundle bytes (determinism)", () => {
    withTmpDir((dir) => {
      const bytes = Buffer.from("deterministic-payload");
      writeFileSync(join(dir, "vilnius.br"), bytes);
      const entries: BundleEntry[] = [
        { cityId: "vilnius", filename: "vilnius.br", sizeBytes: bytes.length },
      ];
      const a = writeManifest(dir, entries, () => 0);
      const b = writeManifest(dir, entries, () => 0);
      expect(a.bundles[0].sha256).toBe(b.bundles[0].sha256);
    });
  });

  it("throws a contextful error when a bundle file is missing", () => {
    withTmpDir((dir) => {
      // Note: no .br file written. writeManifest should fail loudly with
      // the cityId and path so the next debugger doesn't have to guess
      // which build phase was responsible.
      const entries: BundleEntry[] = [
        { cityId: "vilnius", filename: "vilnius.br", sizeBytes: 0 },
      ];
      expect(() => writeManifest(dir, entries, () => 0)).toThrow(
        /writeManifest:.*vilnius.*vilnius\.br/,
      );
    });
  });

  it("emits a valid empty manifest when given no entries", () => {
    withTmpDir((dir) => {
      const manifest = writeManifest(dir, [], () => 42);
      const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      expect(manifest).toEqual(onDisk);
      expect(manifest.generatedAt).toBe(42);
      expect(manifest.bundles).toEqual([]);
    });
  });
});
