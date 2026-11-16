/**
 * Which workers the page starts. This default starts the normal router worker
 * only. An arrive-by Vite build (the default when the package is built)
 * aliases this module to `ptRouterWorkerEntry.arriveBy.ts`; a build with
 * `PTN_ARRIVE_BY_EXPERIMENT=0` never sees the owner worker or its WASM package.
 */
import type { ArriveByLinkFactory } from "./temporalArriveByLink.ts";

export const ROUTER_WORKER_KIND: "default" | "arrive-by" = "default";

/** The default build has no arrive-by owner, so the handle gets no channel. */
export const createArriveByLink: ArriveByLinkFactory | null = null;

export function createRouterWorker(): Worker {
  return new Worker(new URL("./ptRouter.worker.ts", import.meta.url), { type: "module" });
}
