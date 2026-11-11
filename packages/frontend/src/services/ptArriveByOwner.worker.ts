// Arrive-by owner worker (H74): only the owner, beside the default router
// worker. Only an arrive-by build reaches this file (see `ptRouterWorkerEntry.arriveBy.ts`).
//
// The arrive-by glue is bundled statically (an IIFE worker cannot code-split),
// but its WASM is fetched only on the first enable.
import * as arriveByWasm from "@pt/wasm-arrive-by";
import { createArriveByOwnerHost, type ArriveByOwnerWorkerRequest } from "./ptArriveByOwnerHost.ts";
import { createArriveByFeature, type ArriveByWasmModule } from "./temporalArriveByFeature.ts";

type WorkerScope = {
  onmessage: ((event: MessageEvent<ArriveByOwnerWorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

const scope = self as unknown as WorkerScope;
const handle = createArriveByOwnerHost(createArriveByFeature(async () => arriveByWasm as unknown as ArriveByWasmModule));

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
        error: `reply could not be posted: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
};
