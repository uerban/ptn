import { Unzip, UnzipInflate } from "fflate";

export interface ZipCaps {
  zipCompressedBytes: number;
  zipUncompressedBytes: number;
  zipPerEntryBytes: number;
  zipMembers: number;
  zipCompressionRatio: number;
}

/**
 * Check Content-Length (when advertised) against the compressed-size cap.
 * If the server didn't send Content-Length, we can't enforce here — the
 * per-entry + total caps catch oversized archives post-fetch.
 */
export function assertCompressedSize(
  contentLength: number | undefined,
  cap: number,
  url: string,
): void {
  if (contentLength === undefined) return;
  if (contentLength > cap) {
    throw new Error(
      `GTFS feed rejected — compressed size ${contentLength} bytes exceeds cap ${cap} (${url})`,
    );
  }
}

export interface SafeStreamingUnzipCallbacks {
  /**
   * Called once per cleared file in the zip. `chunk` is the next
   * decompressed slice; `final` is `true` for the last chunk of that
   * file. Throwing from here aborts further streaming and surfaces as
   * a rejected promise.
   */
  onFile: (name: string, chunk: Uint8Array, final: boolean) => void;
}

/**
 * Shared cap-enforcement core for both the streaming and buffered paths.
 * Synchronous on purpose: fflate's `Unzip` + `UnzipInflate` decode in-thread,
 * so callbacks fire inside `uz.push()`. Throws on first cap violation, or
 * after `uz.push()` if it deferred a fault into a stored error.
 *
 * Caps enforced here (the "in one place" guarantee):
 *  - per-file uncompressed (`caps.zipPerEntryBytes`) tracked across chunks
 *  - total uncompressed (`caps.zipUncompressedBytes`)
 *  - members count (`caps.zipMembers`)
 *  - aggregate compression ratio (`caps.zipCompressionRatio`, post-stream)
 *  - duplicate filenames (rejected on first repeat that passes the filter)
 *
 * Total compressed budget (`caps.zipCompressedBytes`) is checked by the
 * streaming wrapper only; the buffered path already enforces it via
 * `assertCompressedSize` at fetch time, so re-running it here would break
 * existing buffered call sites that rely on smaller compressed caps.
 */
function runUnzipWithCaps(
  zipBuffer: Uint8Array,
  caps: ZipCaps,
  fileFilter: (name: string) => boolean,
  onFile: (name: string, chunk: Uint8Array, final: boolean) => void,
): void {
  let memberCount = 0;
  let totalUncompressed = 0;
  let firstError: Error | null = null;
  const startedFiles = new Set<string>();

  const fail = (msg: string): void => {
    if (!firstError) firstError = new Error(msg);
  };

  const uz = new Unzip();
  uz.register(UnzipInflate);

  uz.onfile = (file) => {
    if (firstError) return;
    memberCount++;
    if (memberCount > caps.zipMembers) {
      fail(
        `GTFS feed rejected — archive contains more than ${caps.zipMembers} entries`,
      );
      return;
    }
    if (!fileFilter(file.name)) return;

    // Reject duplicate decoded entries. The buffered helper used to silently
    // overwrite (`Record` assignment); the streaming refactor now concatenates
    // chunks into a shared accumulator, which corrupts GTFS parsing. Make it
    // an explicit error so callers see malformed archives rather than mystery
    // parser failures downstream.
    if (startedFiles.has(file.name)) {
      fail(`GTFS feed rejected — duplicate entry ${file.name} in archive`);
      return;
    }
    startedFiles.add(file.name);

    let perFileUncompressed = 0;

    file.ondata = (err, chunk, final) => {
      if (firstError) return;
      if (err) {
        fail(`GTFS feed rejected — fflate error in ${file.name}: ${err.message}`);
        return;
      }
      perFileUncompressed += chunk.byteLength;
      if (perFileUncompressed > caps.zipPerEntryBytes) {
        fail(
          `GTFS feed rejected — entry ${file.name} has per-entry size ${perFileUncompressed} bytes, cap is ${caps.zipPerEntryBytes}`,
        );
        return;
      }
      totalUncompressed += chunk.byteLength;
      if (totalUncompressed > caps.zipUncompressedBytes) {
        fail(
          `GTFS feed rejected — total uncompressed size exceeds cap ${caps.zipUncompressedBytes} bytes`,
        );
        return;
      }
      try {
        onFile(file.name, chunk, final);
      } catch (cbErr) {
        const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
        fail(msg);
      }
    };

    try {
      file.start();
    } catch (startErr) {
      const msg = startErr instanceof Error ? startErr.message : String(startErr);
      fail(`GTFS feed rejected — fflate error starting ${file.name}: ${msg}`);
    }
  };

  try {
    uz.push(zipBuffer, true);
  } catch (pushErr) {
    if (!firstError) {
      const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      fail(`GTFS feed rejected — fflate error: ${msg}`);
    }
  }

  if (firstError) throw firstError;

  if (zipBuffer.byteLength > 0) {
    const ratio = totalUncompressed / zipBuffer.byteLength;
    if (ratio > caps.zipCompressionRatio) {
      throw new Error(
        `GTFS feed rejected — aggregate compression ratio ${ratio.toFixed(1)}x exceeds cap ${caps.zipCompressionRatio}x ` +
        `(${totalUncompressed} uncompressed / ${zipBuffer.byteLength} compressed)`,
      );
    }
  }
}

/**
 * Streaming bounded unzip. Decodes the archive incrementally and enforces the
 * same caps as `safeUnzip`, plus the total-compressed-budget check that the
 * buffered path covers via `assertCompressedSize` at fetch time.
 *
 * `fileFilter` decides which entries to forward to `callbacks.onFile`; filtered
 * entries are still counted toward `zipMembers` but never decoded.
 */
export function safeStreamingUnzip(
  zipBuffer: Uint8Array,
  caps: ZipCaps,
  fileFilter: (name: string) => boolean,
  callbacks: SafeStreamingUnzipCallbacks,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (zipBuffer.byteLength > caps.zipCompressedBytes) {
      reject(
        new Error(
          `GTFS feed rejected — total compressed size ${zipBuffer.byteLength} bytes exceeds cap ${caps.zipCompressedBytes}`,
        ),
      );
      return;
    }
    try {
      runUnzipWithCaps(zipBuffer, caps, fileFilter, callbacks.onFile);
      resolve();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Synchronous bounded unzip. Decompresses the archive using fflate's
 * streaming `Unzip` under the hood and accumulates chunks per filtered file.
 * Enforces the same caps as `safeStreamingUnzip` minus the upfront
 * total-compressed-budget check (which fetch-time `assertCompressedSize`
 * already covers for the buffered path).
 *
 * For `stop_times.txt`, callers use the streaming path in loader.ts and should
 * NOT go through this helper — this is only for the small-files pass.
 */
export function safeUnzip(
  zipBuffer: Uint8Array,
  caps: ZipCaps,
  filter?: (file: { name: string }) => boolean,
): Record<string, Uint8Array> {
  const accumulators = new Map<string, Uint8Array[]>();
  const sizes = new Map<string, number>();

  runUnzipWithCaps(
    zipBuffer,
    caps,
    (name) => (filter ? filter({ name }) : true),
    (name, chunk) => {
      let chunks = accumulators.get(name);
      if (!chunks) {
        chunks = [];
        accumulators.set(name, chunks);
      }
      if (chunk.byteLength > 0) {
        chunks.push(chunk);
        sizes.set(name, (sizes.get(name) ?? 0) + chunk.byteLength);
      }
    },
  );

  const out: Record<string, Uint8Array> = {};
  for (const [name, chunks] of accumulators) {
    const total = sizes.get(name) ?? 0;
    const combined = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      combined.set(c, off);
      off += c.byteLength;
    }
    out[name] = combined;
  }
  return out;
}
