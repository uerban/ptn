// Static import: Vite bundles workers as IIFE, which cannot code-split, so a
// dynamic `import("@pt/wasm")` here fails the build. The wasm-bindgen glue
// ships inside this worker's script instead, and a failure to load it surfaces
// as the worker's `error` event (`PtWasmImportError` on the client).
import * as ptWasm from "@pt/wasm";
import { createPtRouterHost, type PtRouterRequest, type PtWasmModule } from "./ptRouterWorkerHost.ts";

type WorkerScope = {
  onmessage: ((event: MessageEvent<PtRouterRequest>) => void) | null;
  postMessage(message: unknown): void;
};

const scope = self as unknown as WorkerScope;
const handle = createPtRouterHost(async () => ptWasm as unknown as PtWasmModule);

scope.onmessage = (event) => {
  void handle(event.data).then((reply) => {
    try {
      scope.postMessage(reply);
    } catch (err) {
      // An uncloneable result must still answer its request, or the caller
      // waits forever.
      scope.postMessage({
        id: reply.id,
        ok: false,
        stage: "call",
        error: `reply could not be posted: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
};
