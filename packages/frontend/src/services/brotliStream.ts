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
interface BrotliStreamResult {
  buf: Uint8Array;
  code: number;
  input_offset: number;
  free(): void;
}
interface BrotliStreamDecoder {
  decompress(bytes: Uint8Array, outputSize: number): BrotliStreamResult;
  free(): void;
}
export interface WasmBrotliDecoder {
  decompress(bytes: Uint8Array): Uint8Array;
  BrotliDecStream?: new () => BrotliStreamDecoder;
}

export class BrotliOutputLimitError extends Error {
  constructor() {
    super("Brotli decoded output exceeds byte limit");
    this.name = "BrotliOutputLimitError";
  }
}

function join(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return join(chunks, length);
      if (value.length > limit - length) throw new BrotliOutputLimitError();
      chunks.push(value);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function decodeBoundedWasm(bytes: Uint8Array, decoder: WasmBrotliDecoder, limit: number): Uint8Array {
  if (!decoder.BrotliDecStream) throw new Error("bounded Brotli decoder unavailable");
  const stream = new decoder.BrotliDecStream();
  const chunks: Uint8Array[] = [];
  let offset = 0, length = 0;
  try {
    for (;;) {
      // One extra byte distinguishes an exact-size output from an overrun.
      // The decoder's internal dictionary/window is outside this output bound.
      const input = bytes.subarray(offset, Math.min(bytes.length, offset + 65536));
      const result = stream.decompress(input, Math.min(65536, limit - length + 1));
      try {
        const chunk = result.buf;
        if (chunk.length > limit - length) throw new BrotliOutputLimitError();
        if (!Number.isInteger(result.input_offset) || result.input_offset < 0 || result.input_offset > input.length) {
          throw new Error("invalid Brotli stream input offset");
        }
        offset += result.input_offset;
        chunks.push(chunk);
        length += chunk.length;
        if (result.code === 1) return join(chunks, length); // ResultSuccess
        if ((result.code !== 2 && result.code !== 3)
            || (chunk.length === 0 && result.input_offset === 0)
            || (result.code === 2 && offset === bytes.length)) {
          throw new Error("incomplete or stalled Brotli stream");
        }
        // NeedsMoreInput/Output: continue from the unconsumed bytes. Input
        // is chunked too, so wasm-bindgen never recopies a huge remaining
        // compressed suffix on every output call. An empty suffix can still
        // drain buffered output, but cannot satisfy NeedsMoreInput.
      } finally { result.free(); }
    }
  } finally { stream.free(); }
}

/** Brotli-decode to raw bytes, native first. An optional declared output
 *  limit uses streaming on both paths and is never bypassed by retrying an
 *  overrun. It bounds retained output, not the decoder's internal dictionary
 *  or total heap. Legacy callers without a bound keep their one-shot fallback. */
export async function decodeBrotliBytes(
  buffer: ArrayBuffer,
  loadWasmDecoder: () => Promise<WasmBrotliDecoder>,
  maxOutputBytes?: number,
): Promise<Uint8Array> {
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
    throw new RangeError("invalid Brotli output limit");
  }
  const ds = nativeBrotliStream();
  if (ds) {
    try {
      // Start draining the readable side BEFORE writing: a multi-MB output
      // backs the stream up, and awaiting the write first would deadlock.
      const out = maxOutputBytes === undefined
        ? new Response(ds.readable).arrayBuffer().then(bytes => new Uint8Array(bytes))
        : readBounded(ds.readable, maxOutputBytes);
      const writer = ds.writable.getWriter();
      // Bad bytes reject these too; `out` carries that error, so the copies
      // here must not surface as unhandled rejections.
      writer.write(new Uint8Array(buffer)).catch(() => {});
      writer.close().catch(() => {});
      return await out;
    } catch (error) {
      if (error instanceof BrotliOutputLimitError) throw error;
      // the native decoder failed on these bytes; let the wasm one try
    }
  }
  const brotli = await loadWasmDecoder();
  return maxOutputBytes === undefined ? brotli.decompress(new Uint8Array(buffer))
    : decodeBoundedWasm(new Uint8Array(buffer), brotli, maxOutputBytes);
}
