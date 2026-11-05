import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Holds the pre-computed pedestrian transfers artifact (`transfers.bin`,
 * PTFT wire format from `@pt/shared/transfers/wire.ts`). Loaded once at
 * boot and re-read when the on-disk file's mtime changes. Independent of
 * the GTFS swap lifecycle: the transfers artifact is built offline by
 * `scripts/build-transfers.mjs` and may change asynchronously w.r.t. the
 * GTFS feed.
 *
 * Mtime is checked lazily on `getStatus()` rather than via fs.watch, so a
 * test or container that rewrites the file mid-process doesn't depend on
 * platform watcher semantics.
 */
export class TransfersStore {
  private bytes: Buffer | null = null;
  private gzipBytes: Buffer | null = null;
  private hash = "";
  private sizeBytes = 0;
  private lastMtimeMs = 0;
  private filePath: string;
  // Tracks the last non-ENOENT stat error code so we log once per
  // transition (including the first-boot "permission denied" case).
  private lastStatErrorCode: string | null = null;

  constructor(
    private readonly cityId: string,
    private readonly variant: string,
    dataDir: string,
  ) {
    this.filePath = path.join(dataDir, "transfers", cityId, variant, "transfers.bin");
    this.reloadIfChanged();
  }

  /**
   * Stat the file and reload if mtime changed (or if we have no prior
   * snapshot). When the file is absent the store stays in the "absent"
   * state (bytes=null) and `isPresent()` returns false.
   */
  private reloadIfChanged(): void {
    let stat;
    try {
      stat = statSync(this.filePath);
    } catch (err) {
      this.handleFsError(err);
      return;
    }
    this.lastStatErrorCode = null;

    const mtimeMs = stat.mtimeMs;
    if (this.bytes != null && mtimeMs === this.lastMtimeMs) {
      return;
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(this.filePath);
    } catch (err) {
      // File unlinked/replaced between stat and read (atomic-rename
      // build scripts can trigger this). Degrade to absent so the route
      // returns 404 rather than 500; next reloadIfChanged will pick up
      // the new file.
      this.handleFsError(err);
      return;
    }
    // Re-stat after read so an in-flight rewrite (stat → write → read) is
    // detected on the next call: the read produced bytes whose mtime is
    // the *new* mtime, not the one we sampled before the read.
    let postReadMtime = mtimeMs;
    try {
      postReadMtime = statSync(this.filePath).mtimeMs;
    } catch {
      // File deleted between read and re-stat — keep what we read; the
      // next reloadIfChanged will hit the ENOENT branch and clear state.
    }
    this.bytes = bytes;
    this.gzipBytes = gzipSync(bytes);
    this.hash = createHash("sha256").update(bytes).digest("hex");
    this.sizeBytes = bytes.length;
    this.lastMtimeMs = postReadMtime;
  }

  private handleFsError(err: unknown): void {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    if (code !== "ENOENT") {
      // Permission errors or transient fs failures shouldn't crash the
      // server — degrade to "no transfers" and let RAPTOR fall back to
      // haversine. Log once per error-code transition so the first
      // permission failure on boot is still surfaced.
      if (code !== this.lastStatErrorCode) {
        console.warn(
          `[transfersStore] read ${this.filePath} failed (${code}); treating as absent`,
        );
        this.lastStatErrorCode = code;
      }
    } else {
      this.lastStatErrorCode = null;
    }
    this.bytes = null;
    this.gzipBytes = null;
    this.hash = "";
    this.sizeBytes = 0;
    this.lastMtimeMs = 0;
  }

  /**
   * Public URL the frontend should fetch. The edge proxy (nginx in prod,
   * vite dev proxy locally) strips `/api/<city>/` to `/api/` before the
   * request reaches Fastify, so the backend route is `/api/transfers/fetch`.
   */
  getUrl(): string {
    return `/api/${this.cityId}/transfers/fetch`;
  }

  getHash(): string {
    this.reloadIfChanged();
    return this.hash;
  }

  getSizeBytes(): number {
    this.reloadIfChanged();
    return this.sizeBytes;
  }

  /** Raw artifact bytes, or null when the file is absent. */
  getBytes(): Buffer | null {
    this.reloadIfChanged();
    return this.bytes;
  }

  /** Pre-gzipped artifact bytes, or null when the file is absent. */
  getGzipBytes(): Buffer | null {
    this.reloadIfChanged();
    return this.gzipBytes;
  }

  isPresent(): boolean {
    this.reloadIfChanged();
    return this.bytes != null;
  }

  /**
   * Atomic snapshot for the HTTP route: hash, raw bytes, and gzipped bytes
   * from the same `reloadIfChanged` call. Avoids the race where one getter
   * triggers a reload between two reads, producing a response with the old
   * hash and new body (or vice versa).
   */
  getSnapshot(): { hash: string; bytes: Buffer; gzipBytes: Buffer } | null {
    this.reloadIfChanged();
    if (this.bytes == null || this.gzipBytes == null) return null;
    return { hash: this.hash, bytes: this.bytes, gzipBytes: this.gzipBytes };
  }

  /**
   * Manifest-shaped snapshot for inclusion in `RoutingBundleData.meta`.
   * Returns `null` when the file is absent so callers can omit the field.
   */
  getArtifactMeta(): { url: string; hash: string; sizeBytes: number } | null {
    if (!this.isPresent()) return null;
    return {
      url: this.getUrl(),
      hash: this.hash,
      sizeBytes: this.sizeBytes,
    };
  }
}
