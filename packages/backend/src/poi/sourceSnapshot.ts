import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface SourceSnapshot {
  url: string;
  path: string;
  sha256: string;
  bytes: number;
  /** PBF header replication timestamp; never download time or local mtime. */
  snapshotAt: string;
  checkedAt: string;
  downloadedAt: string;
  etag?: string;
  lastModified?: string;
}

export function inspectPbf(path: string): string {
  const result = spawnSync("osmium", ["fileinfo", "-F", "pbf", "-g", "header.option.osmosis_replication_timestamp", path], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  const timestamp = result.stdout.trim();
  if (result.status !== 0 || !timestamp || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("PBF has no valid upstream replication timestamp");
  }
  return new Date(timestamp).toISOString();
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Revalidate a URL, then freeze the PBF by content hash. A failed refresh never
 * changes the previous cache record or source bytes. Caller may retain an already
 * published release, but must not label a failed check as a new source snapshot. */
export async function refreshSnapshot(
  url: string,
  cache: string,
  options: {
    fetch?: typeof fetch;
    now?: () => Date;
    inspect?: (path: string) => string | Promise<string>;
    maxBytes?: number;
    forceAfterMs?: number;
    /** Abort when no response bytes arrive for this long (default 2 min). */
    stallTimeoutMs?: number;
  } = {},
): Promise<SourceSnapshot> {
  if (new URL(url).protocol !== "https:") throw new Error("PBF source must use HTTPS");
  const now = (options.now ?? (() => new Date()))();
  const get = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 4 * 1024 ** 3;
  const forceAfter = options.forceAfterMs ?? 7 * 86400_000;
  const objects = join(cache, "sources", "sha256");
  const records = join(cache, "sources", "urls");
  await mkdir(objects, { recursive: true });
  await mkdir(records, { recursive: true });
  const record = join(records, `${createHash("sha256").update(url).digest("hex")}.json`);
  let previous: SourceSnapshot | undefined;
  try {
    const saved = JSON.parse(await readFile(record, "utf8")) as SourceSnapshot;
    if (saved.url === url && /^[a-f0-9]{64}$/.test(saved.sha256)) {
      // Derive paths from trusted configuration/hash, not a cache JSON path.
      saved.path = join(objects, `${saved.sha256}.osm.pbf`);
      if ((await stat(saved.path)).size === saved.bytes && await checksum(saved.path) === saved.sha256) previous = saved;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const headers: Record<string, string> = { "Accept-Encoding": "identity" };
  const age = previous ? now.getTime() - Date.parse(previous.downloadedAt) : Infinity;
  if (previous && age >= 0 && age < forceAfter) {
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    else if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;
  }
  // Bound the download by inactivity, not total time: a country extract can
  // take longer than any fixed limit on a slow link, and the caller's build
  // timeout already caps the whole run.
  const stallMs = options.stallTimeoutMs ?? 120_000;
  const controller = new AbortController();
  const signal = controller.signal;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error(`PBF download stalled for ${stallMs} ms`)), stallMs);
  };
  progress();
  try {
    // Geofabrik answers `*-latest` with a 307 to a dated object. Follow a few
    // same-origin HTTPS redirects only; anything else is refused.
    let response = await get(url, { headers, redirect: "manual", signal });
    for (let hops = 0; response.status >= 300 && response.status < 400 && response.status !== 304; hops++) {
      const location = response.headers.get("Location");
      const next = location ? new URL(location, url) : undefined;
      if (hops >= 3 || !next || next.protocol !== "https:" || next.origin !== new URL(url).origin)
        throw new Error(`PBF refresh refused redirect: HTTP ${response.status}`);
      await response.body?.cancel();
      response = await get(next.href, { headers, redirect: "manual", signal });
    }
    const save = async (snapshot: SourceSnapshot) => {
      const temporary = `${record}.${randomUUID()}.part`;
      try { await writeFile(temporary, JSON.stringify(snapshot)); await rename(temporary, record); }
      finally { await rm(temporary, { force: true }); }
      return snapshot;
    };
    if (response.status === 304) {
      if (!previous || !("If-None-Match" in headers || "If-Modified-Since" in headers)) throw new Error("unsolicited PBF not-modified response");
      return save({ ...previous, checkedAt: now.toISOString() });
    }
    if (!response.ok || !response.body) throw new Error(`PBF refresh failed: HTTP ${response.status}`);
    if (response.headers.get("Content-Encoding") && response.headers.get("Content-Encoding") !== "identity") throw new Error("PBF response must not transform bytes");
    const advertised = response.headers.get("Content-Length");
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) throw new Error("PBF exceeds source size limit");
    const temporary = join(objects, `${randomUUID()}.part`);
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        new Transform({ transform(chunk: Buffer, _encoding, callback) {
          progress();
          bytes += chunk.length;
          if (bytes > maxBytes) return callback(new Error("PBF exceeds source size limit"));
          hash.update(chunk); callback(null, chunk);
        } }),
        createWriteStream(temporary, { flags: "wx" }),
        { signal },
      );
      clearTimeout(stallTimer);
      if (!bytes || (advertised && bytes !== Number(advertised))) throw new Error("PBF size mismatch");
      const snapshotAt = await (options.inspect ?? inspectPbf)(temporary);
      if (!Number.isFinite(Date.parse(snapshotAt)) || Date.parse(snapshotAt) > now.getTime() + 300_000) throw new Error("invalid PBF snapshot timestamp");
      const sha256 = hash.digest("hex");
      const path = join(objects, `${sha256}.osm.pbf`);
      await rename(temporary, path);
      return save({ url, path, sha256, bytes, snapshotAt: new Date(snapshotAt).toISOString(),
        checkedAt: now.toISOString(), downloadedAt: now.toISOString(),
        ...(response.headers.get("ETag") ? { etag: response.headers.get("ETag")! } : {}),
        ...(response.headers.get("Last-Modified") ? { lastModified: response.headers.get("Last-Modified")! } : {}),
      });
    } finally { await rm(temporary, { force: true }); }
  } catch (error) {
    // Report the stall, not the generic AbortError it surfaces as.
    throw signal.aborted ? signal.reason : error;
  } finally { clearTimeout(stallTimer); }
}
