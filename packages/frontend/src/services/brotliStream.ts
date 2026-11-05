/**
 * Brotli decoding with no dynamic import, so a worker bundle (IIFE, which
 * cannot code-split) can include it. `brotliDecode.ts` wraps it with a lazy
 * import of the wasm fallback for the page.
 */

/** Native decoder names, standard first. Chromium shipped "brotli"; "br"
 *  is the HTTP token some engines accepted before the name settled. */
const NATIVE_FORMATS = ["brotli", "br"] as const;

export function nativeBrotliStream(): DecompressionStream | null {
  if (typeof DecompressionStream === "undefined") return null;
  for (const format of NATIVE_FORMATS) {
    try {
      return new DecompressionStream(format as CompressionFormat);
    } catch {
      // this engine does not know this name
    }
  }
  return null;
}

/** The part of brotli-dec-wasm the fallback calls. */
export interface WasmBrotliDecoder {
  decompress(bytes: Uint8Array): Uint8Array;
}

/** Brotli-decode to raw bytes: the native stream when this engine has one,
 *  else the wasm decoder `loadWasmDecoder` supplies. */
export async function decodeBrotliBytes(
  buffer: ArrayBuffer,
  loadWasmDecoder: () => Promise<WasmBrotliDecoder>,
): Promise<Uint8Array> {
  const ds = nativeBrotliStream();
  if (ds) {
    try {
      // Start draining the readable side BEFORE writing: a multi-MB output
      // backs the stream up, and awaiting the write first would deadlock.
      const out = new Response(ds.readable).arrayBuffer();
      const writer = ds.writable.getWriter();
      // Bad bytes reject these too; `out` carries that error, so the copies
      // here must not surface as unhandled rejections.
      writer.write(new Uint8Array(buffer)).catch(() => {});
      writer.close().catch(() => {});
      return new Uint8Array(await out);
    } catch {
      // the native decoder failed on these bytes; let the wasm one try
    }
  }
  const brotli = await loadWasmDecoder();
  return brotli.decompress(new Uint8Array(buffer));
}
