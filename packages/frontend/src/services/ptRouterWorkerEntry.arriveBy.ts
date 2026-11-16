/**
 * Replacement for `ptRouterWorkerEntry.ts`, selected by the Vite alias in an
 * arrive-by build (the default). The page starts the default router worker
 * unchanged and, beside it, the arrive-by owner in its own worker (H74).
 */
import { createArriveByLink as create, type ArriveByLinkFactory } from "./temporalArriveByLink.ts";

export const ROUTER_WORKER_KIND: "default" | "arrive-by" = "arrive-by";

export const createArriveByLink: ArriveByLinkFactory | null = (bundle) =>
  create(() => new Worker(new URL("./ptArriveByOwner.worker.ts", import.meta.url), { type: "module" }), bundle);

export function createRouterWorker(): Worker {
  return new Worker(new URL("./ptRouter.worker.ts", import.meta.url), { type: "module" });
}
