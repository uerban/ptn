import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { BundleManifest } from "@pt/shared";
import type { ManifestSnapshot } from "./scheduler.js";

/**
 * Producer-side schedule-tile source resolver (interim spike-killer).
 *
 * When `PT_SCHEDULE_TILE_SOURCE=producer`, the backend SERVES schedule tiles
 * from — and ADVERTISES the hash of — the bundle the producer already built
 * into the published generation dir, instead of building its own in-process
 * copy. Tasks 1-2 made the producer write
 * `<genDir>/schedule-tiles/<bundleHash>/<tileSize>/<coords>.br` plus
 * `<genDir>/schedule-tiles/manifest.json` (carrying `bundleHash` == the
 * generationId). This module is the read side.
 *
 * Gen-dir resolution mirrors `pt-startup.sh` (the same boot path
 * `loadFromPtb` uses): read `<PT_DATA_ROOT>/current.json` → `generationId` →
 * `<PT_DATA_ROOT>/generations/<generationId>/schedule-tiles`.
 *
 * CRITICAL — generation roll (cache-key lesson, PR #337). pt-serve self-reloads
 * and the producer publishes new generations, so the gen dir changes UNDER the
 * backend. The resolved dir / current hash / manifest body MUST NOT be frozen
 * at boot — they are re-resolved on every call: `current.json` is read and
 * parsed each time, and the gen dir is only re-resolved when the parsed
 * `generationId` STRING changes. This is correct because `current.json` is
 * constant-size across generations (generationId is always 64 hex chars;
 * citySlug, schemaVersion=1, and createdAt don't change length), so an
 * `(mtime,size)` pre-gate is NOT a reliable cache key — two rolls that happen
 * within the same millisecond would collide and permanently serve the stale
 * gen dir until restart. Keying on the parsed `generationId` content is
 * both cheap (the file is tiny — a couple hundred bytes) and correct.
 */

/** 64 lowercase hex chars — the shape of a content-addressed generationId. */
const GENERATION_ID_RE = /^[0-9a-f]{64}$/;

interface PointerManifest {
  generationId?: unknown;
}

interface ManifestCacheEntry {
  /** Cache key: the parsed `generationId` string from `current.json`. */
  generationId: string;
  /** `<dataRoot>/generations/<generationId>/schedule-tiles`. */
  scheduleTilesDir: string;
}

export interface ProducerScheduleTileSource {
  /**
   * Re-resolve `<genDir>/schedule-tiles` from the live `current.json`.
   * Returns `null` when `PT_DATA_ROOT` is unset, `current.json` is
   * absent/unreadable/malformed, or its `generationId` is invalid.
   */
  resolveDataDir(): string | null;
  /**
   * Read the current schedule-tile bundle hash from the gen dir's
   * `schedule-tiles/manifest.json`. Returns `null` when the dir can't be
   * resolved or the manifest is absent/unreadable/malformed. Returns the
   * previous-good hash on a transient/mid-rename read of `current.json` (not
   * just null) as long as the previous-good gen dir still exists on disk.
   */
  getCurrentBundleHash(): string | null;
  /**
   * Read the gen dir's `schedule-tiles/manifest.json` as a `ManifestSnapshot`
   * (the shape both tile routes and the manifest route consume), so the route
   * sees the producer's subdivision plan + bundleHash. `null` when the dir
   * can't be resolved or the manifest is absent/unreadable/malformed.
   */
  getManifestSnapshot(): ManifestSnapshot | null;
}

/** Minimal logger shape (fastify pino `log.warn(obj, msg)`). */
export interface ProducerSourceLogger {
  warn: (obj: object, msg: string) => void;
}

/**
 * Build a producer schedule-tile source over `PT_DATA_ROOT`. `dataRoot` is
 * read once at construction (it's a process-level boot env, never rolled); the
 * GENERATION it points at is re-resolved per call so a generation roll is
 * picked up live.
 *
 * `opts.log` (optional) receives a `warn` for genuinely-abnormal states only —
 * a malformed/unreadable `current.json` or `manifest.json`, an invalid
 * `generationId`, or a non-ENOENT `stat` failure. The normal cold-start path
 * (absent `current.json` / absent manifest) stays quiet.
 */
export function createProducerScheduleTileSource(
  dataRoot: string | undefined,
  opts?: { log?: ProducerSourceLogger },
): ProducerScheduleTileSource {
  const log = opts?.log;
  // Per-process cache keyed on the PARSED generationId string from
  // current.json. Re-resolved (current.json re-read and parsed) on every call
  // so a generation roll is always detected. Only the gen-dir path computation
  // is cached — the tiny (a couple hundred bytes) read+parse is negligible on
  // this non-hot path.
  let pointerCache: ManifestCacheEntry | null = null;
  // Per-process retained parse of the gen-dir schedule-tiles/manifest.json,
  // keyed on (path,mtime,size). A new generation lives in a NEW path so the
  // path component invalidates across rolls even if mtime/size collide.
  let manifestCache:
    | { path: string; stat: { mtimeMs: number; size: number }; snapshot: ManifestSnapshot }
    | null = null;

  function resolveDataDir(): string | null {
    if (!dataRoot) return null;
    const currentPath = join(dataRoot, "current.json");
    // Always read+parse current.json on every call — it's ~166 bytes and the
    // schedule-tile route is not a hot path. Keying on (mtime,size) is NOT
    // safe: current.json is constant-size across generations, so two rolls
    // within the same millisecond would collide and permanently serve a stale
    // gen dir until restart. Content-identity (generationId string) is correct.
    let pointer: PointerManifest;
    try {
      pointer = JSON.parse(readFileSync(currentPath, "utf8")) as PointerManifest;
    } catch (err) {
      // current.json absent or malformed (mid-publish race). Fall back to the
      // previous-good resolution rather than blanking out the source.
      //
      // Corner case: the previous-good dir MAY have been reaped by the bundle
      // janitor. If it no longer exists, return null so the route degrades to
      // "unavailable" rather than advertising a reaped hash.
      //
      // An absent current.json (cold start, before first publish) is normal —
      // stay quiet (ENOENT). A read/parse failure of an existing file is not.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log?.warn?.({ err, currentPath }, "producer schedule-tile source: current.json unreadable/malformed");
      }
      if (pointerCache && existsSync(pointerCache.scheduleTilesDir)) {
        return pointerCache.scheduleTilesDir;
      }
      return null;
    }
    const generationId = pointer.generationId;
    if (typeof generationId !== "string" || !GENERATION_ID_RE.test(generationId)) {
      // Invalid generationId in current.json — same fallback with reaped-dir guard.
      //
      // Corner case: the previous-good dir MAY have been reaped by the bundle
      // janitor. If it no longer exists, return null so the route degrades to
      // "unavailable" rather than advertising a reaped hash.
      log?.warn?.(
        { generationId, currentPath },
        "producer schedule-tile source: current.json has an invalid generationId",
      );
      if (pointerCache && existsSync(pointerCache.scheduleTilesDir)) {
        return pointerCache.scheduleTilesDir;
      }
      return null;
    }
    // Only recompute the path when the generationId actually changed.
    if (pointerCache && pointerCache.generationId === generationId) {
      return pointerCache.scheduleTilesDir;
    }
    const scheduleTilesDir = join(dataRoot, "generations", generationId, "schedule-tiles");
    pointerCache = { generationId, scheduleTilesDir };
    return scheduleTilesDir;
  }

  function getManifestSnapshot(): ManifestSnapshot | null {
    const dir = resolveDataDir();
    if (!dir) return null;
    const manifestPath = join(dir, "manifest.json");
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(manifestPath);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      // ENOENT = normal cold-start / never-published / build-in-progress — quiet.
      // Any other stat failure (EACCES, EIO, …) is abnormal — surface it.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log?.warn?.({ err, manifestPath }, "producer schedule-tile source: manifest stat failed");
      }
      return null; // manifest absent (build in progress / never published)
    }
    if (
      manifestCache &&
      manifestCache.path === manifestPath &&
      manifestCache.stat.mtimeMs === st.mtimeMs &&
      manifestCache.stat.size === st.size
    ) {
      return manifestCache.snapshot;
    }
    let text: string;
    let parsed: BundleManifest;
    try {
      text = readFileSync(manifestPath, "utf8");
      parsed = JSON.parse(text) as BundleManifest;
    } catch (err) {
      // statSync above already succeeded, so the file existed a moment ago — a
      // read/parse failure here is a torn write or a TOCTOU reap, not the normal
      // cold-start path. Warn (but still degrade to the previous-good snapshot).
      log?.warn?.({ err, manifestPath }, "producer schedule-tile source: manifest unreadable/malformed");
      return manifestCache?.snapshot ?? null; // transient read/parse error
    }
    if (typeof parsed.bundleHash !== "string") return manifestCache?.snapshot ?? null;
    const contentEtag = createHash("sha256").update(text).digest("hex").slice(0, 32);
    const snapshot: ManifestSnapshot = {
      bundleHash: parsed.bundleHash,
      subdivisions: parsed.subdivisions,
      contentEtag,
      parsed,
    };
    manifestCache = { path: manifestPath, stat: st, snapshot };
    return snapshot;
  }

  function getCurrentBundleHash(): string | null {
    return getManifestSnapshot()?.bundleHash ?? null;
  }

  return { resolveDataDir, getCurrentBundleHash, getManifestSnapshot };
}
