import { writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BundleManifest, SubdivisionPlan } from "@pt/shared";

export interface WriteBundleManifestInput {
  dataDir: string;
  bundleHash: string;
  generatedAt: number;
  tileSize: number;
  /** Per-cell subdivision plans (keyed by `<x>_<y>`); omitted when no cell split. */
  subdivisions?: Record<string, SubdivisionPlan>;
}

/**
 * Write the per-city `manifest.json` at the dataDir root. The file shape is
 * the `BundleManifest` interface from `@pt/shared`: the same shape served by
 * `GET /api/gtfs/manifest` in PR 3.
 *
 * Atomic: writes to `manifest.json.tmp`, then `renameSync` over the live
 * file. POSIX rename(2) is atomic on the same filesystem; readers see either
 * the old manifest or the new manifest, never a torn JSON.
 */
export function writeBundleManifest(input: WriteBundleManifestInput): void {
  const { dataDir, bundleHash, generatedAt, tileSize, subdivisions } = input;
  const finalPath = join(dataDir, "manifest.json");
  const tmpPath = `${finalPath}.tmp`;

  const manifest: BundleManifest = {
    schemaVersion: 1,
    bundleHash,
    generatedAt,
    tileSize,
    ...(subdivisions && Object.keys(subdivisions).length > 0 ? { subdivisions } : {}),
  };

  // Best-effort cleanup of stale tmp from a previous failed write.
  if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });

  try {
    writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    throw err;
  }
}
