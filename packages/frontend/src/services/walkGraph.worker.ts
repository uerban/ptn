// Static imports: Vite bundles workers as IIFE, which cannot code-split, so a
// dynamic `import()` of either wasm package here fails the build (see
// ptRouter.worker.ts). Both glue modules ship inside this worker's script; the
// wasm binaries are fetched only when first instantiated below.
import * as ptWasm from "@pt/wasm";
import initBrotli, { decompress as brotliDecompress } from "brotli-dec-wasm/web";
import { decodeBrotliBytes, type WasmBrotliDecoder } from "./brotliStream.ts";
import type { WalkWasmModule } from "./walkGraphClient.ts";
import { createWalkGraphHost, type WalkGraphRequest } from "./walkGraphWorkerHost.ts";

type WorkerScope = {
  onmessage: ((event: MessageEvent<WalkGraphRequest>) => void) | null;
  postMessage(message: unknown): void;
};

/** Init once; a failure (e.g. the wasm fetch while offline) is retried. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    p ??= make().catch((err: unknown) => {
      p = null;
      throw err;
    });
    return p;
  };
}

const loadPtWasm = once(async () => {
  const mod = ptWasm as unknown as WalkWasmModule;
  await mod.default();
  return mod;
});
// Only used where the native Brotli DecompressionStream is missing.
const loadBrotli = once(async (): Promise<WasmBrotliDecoder> => {
  await initBrotli();
  return { decompress: brotliDecompress };
});

const scope = self as unknown as WorkerScope;
const host = createWalkGraphHost({
  fetch: (input, init) => fetch(input, init),
  loadModule: loadPtWasm,
  decompress: (buffer) => decodeBrotliBytes(buffer, loadBrotli),
});

scope.onmessage = (event) => {
  void host.handle(event.data).then((reply) => {
    try {
      scope.postMessage(reply);
    } catch (err) {
      // An uncloneable route must still answer its request, or the caller
      // waits forever.
      scope.postMessage({
        id: reply.id,
        op: reply.op,
        status: "transient",
        route: null,
        error: `reply could not be posted: ${err instanceof Error ? err.message : String(err)}`,
        loadedCity: reply.loadedCity,
      });
    }
  });
};
