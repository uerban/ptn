import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_HASH_RE = /^[0-9a-f]{64}$/;

export interface SweepBundleJanitorInput {
  dataDir: string;
  /**
 * Number of newest bundle dirs to retain.
 */
  keepCount: number;
  /** When true, do not actually delete; just report what would be removed. */
  dryRun?: boolean;
}

export interface SweepBundleJanitorResult {
  kept: string[];
  deleted: string[];
}

/**
 * Delete all bundle directories under `dataDir` except the newest `keepCount`, sorted by mtime
 * descending.

 *
 * Filters: only entries matching `^[0-9a-f]{64}$` (a SHA-256 hex hash) are
 * candidates. `manifest.json`, `<hash>.tmp` directories from in-flight builds,
 * and any other extras are left alone.
 *
 * Idempotent: running twice with no new bundles is a no-op.
 *
 * Synchronous because the janitor runs after a synchronous `buildBundle` in
 * the offline build pipeline.
 */
export function sweepBundleJanitor(input: SweepBundleJanitorInput): SweepBundleJanitorResult {
  const { dataDir, keepCount, dryRun = false } = input;

  if (!existsSync(dataDir)) {
    return { kept: [], deleted: [] };
  }

  const entries = readdirSync(dataDir)
    .filter((name) => BUNDLE_HASH_RE.test(name))
    .map((name) => {
      const path = join(dataDir, name);
      return { name, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const kept = entries.slice(0, keepCount).map((e) => e.name);
  const toDelete = entries.slice(keepCount).map((e) => e.name);

  if (!dryRun) {
    for (const name of toDelete) {
      rmSync(join(dataDir, name), { recursive: true, force: true });
    }
  }

  return { kept, deleted: toDelete };
}
