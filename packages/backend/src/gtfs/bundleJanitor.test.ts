import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepBundleJanitor } from "./bundleJanitor.js";

function makeBundleDir(dataDir: string, hash: string, mtimeSec: number): void {
  const dir = join(dataDir, hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), "{}");
  utimesSync(dir, mtimeSec, mtimeSec);
}

const HASH = (n: number) => n.toString(16).padStart(64, "0");

describe("sweepBundleJanitor", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-jan-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("keeps the newest `keepCount` bundle dirs and deletes older ones", () => {
    makeBundleDir(dataDir, HASH(1), 1700000000); // oldest
    makeBundleDir(dataDir, HASH(2), 1700000100);
    makeBundleDir(dataDir, HASH(3), 1700000200); // newest

    const result = sweepBundleJanitor({ dataDir, keepCount: 2 });

    expect(result.kept.sort()).toEqual([HASH(2), HASH(3)].sort());
    expect(result.deleted).toEqual([HASH(1)]);

    const remaining = readdirSync(dataDir).sort();
    expect(remaining).toEqual([HASH(2), HASH(3)].sort());
  });

  it("ignores entries that don't look like a bundle hash (e.g. manifest.json, .tmp dirs)", () => {
    makeBundleDir(dataDir, HASH(1), 1700000000);
    makeBundleDir(dataDir, HASH(2), 1700000100);
    writeFileSync(join(dataDir, "manifest.json"), '{"cities":[]}');
    mkdirSync(join(dataDir, `${HASH(3)}.tmp`), { recursive: true });

    const result = sweepBundleJanitor({ dataDir, keepCount: 1 });

    expect(result.kept).toEqual([HASH(2)]);
    expect(result.deleted).toEqual([HASH(1)]);
    expect(statSync(join(dataDir, "manifest.json")).isFile()).toBe(true);
    expect(statSync(join(dataDir, `${HASH(3)}.tmp`)).isDirectory()).toBe(true);
  });

  it("returns empty result when dataDir has fewer than keepCount bundles", () => {
    makeBundleDir(dataDir, HASH(1), 1700000000);

    const result = sweepBundleJanitor({ dataDir, keepCount: 5 });

    expect(result.kept).toEqual([HASH(1)]);
    expect(result.deleted).toEqual([]);
  });

  it("dry-run mode reports what would be deleted without removing files", () => {
    makeBundleDir(dataDir, HASH(1), 1700000000);
    makeBundleDir(dataDir, HASH(2), 1700000100);

    const result = sweepBundleJanitor({ dataDir, keepCount: 1, dryRun: true });

    expect(result.kept).toEqual([HASH(2)]);
    expect(result.deleted).toEqual([HASH(1)]);
    expect(statSync(join(dataDir, HASH(1))).isDirectory()).toBe(true);
  });
});
