import { decodeBrotliBytes, nativeBrotliStream, type WasmBrotliDecoder } from "./brotliStream.ts";

export type { WasmBrotliDecoder } from "./brotliStream.ts";

/** Pre-pay the one-time brotli-dec-wasm instantiate cost OFF the interaction
 *  path. Same native-first feature-detect as decompressBrotli: a no-op when a
 *  native Brotli DecompressionStream works, instantiates the wasm only
 *  otherwise. Never throws (warm-up is best-effort). */
export async function warmupBrotli(): Promise<void> {
  try {
    if (nativeBrotliStream()) return;
    await (await import("brotli-dec-wasm")).default;
  } catch { /* best-effort */ }
}

/** brotli-dec-wasm's main entry default-exports a Promise that resolves (after
 *  wasm init) to the module namespace carrying `decompress`; there is NO
 *  top-level named `decompress` export. Await the default, then call decompress.
 *  (Destructuring `{ decompress }` off the import yields undefined → "o is not a
 *  function", which silently broke ALL POI decompression in real browsers, where
 *  a native Brotli DecompressionStream is unsupported so this fallback is the
 *  only path.) */
async function importWasmBrotli(): Promise<WasmBrotliDecoder> {
  return (await import("brotli-dec-wasm")).default;
}

/** Brotli-decode to raw bytes (binary artifacts such as the walk graph).
 *  `loadWasmDecoder` replaces the dynamic import of the wasm fallback. */
export async function decompressBrotliBytes(
  buffer: ArrayBuffer,
  loadWasmDecoder: () => Promise<WasmBrotliDecoder> = importWasmBrotli,
): Promise<Uint8Array> {
  return decodeBrotliBytes(buffer, loadWasmDecoder);
}

export async function decompressBrotli(buffer: ArrayBuffer): Promise<string> {
  return new TextDecoder().decode(await decompressBrotliBytes(buffer));
}
