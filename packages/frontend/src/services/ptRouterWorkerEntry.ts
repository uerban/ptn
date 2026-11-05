/**
 * Which workers the page starts. This default starts the normal router worker
 * only. A `PTN_ARRIVE_BY_EXPERIMENT=1` Vite build aliases this module to
 * `ptRouterWorkerEntry.arriveBy.ts`, so the default build never sees the
 * opt-in owner worker or its WASM package.
 */
import type { ArriveByLinkFactory } from "./temporalArriveByLink.ts";

export const ROUTER_WORKER_KIND: "default" | "arrive-by" = "default";

/** The default build has no arrive-by owner, so the handle gets no channel. */
export const createArriveByLink: ArriveByLinkFactory | null = null;

export function createRouterWorker(): Worker {
  return new Worker(new URL("./ptRouter.worker.ts", import.meta.url), { type: "module" });
}
