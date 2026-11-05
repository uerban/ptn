/**
 * Message protocol and request handler for the dedicated worker that owns one
 * `PtRouter` (`ptRouter.worker.ts`). Kept free of `self` so the handler runs
 * unchanged in unit tests; the worker entry only wires it to `postMessage`.
 *
 * One worker hosts one router for its whole life: `init` builds it, and the
 * client frees it by terminating the worker, which drops the worker's entire
 * wasm heap. There is no `free` request.
 */

export type PtRouterRequest =
  | { id: number; op: "init"; bytes: ArrayBuffer; mode: string }
  | { id: number; op: "plan"; query: unknown }
  | { id: number; op: "resolveTime"; departureUnix: number }
  | { id: number; op: "setTransfers"; bytes: ArrayBuffer };

/** Epoch milliseconds (`timeOrigin + now()`), so the page can re-base them onto
 *  its own timeline: a worker's `performance.now()` has a different origin. */
export interface PtRouterInitMarks {
  importStart: number;
  importEnd: number;
  instantiateStart: number;
  instantiateEnd: number;
  ptnewStart: number;
  ptnewEnd: number;
}

/** Where a failed request failed. The client maps it to the typed engine error
 *  the in-process path would have thrown at the same point. */
export type PtRouterFailureStage = "import" | "instantiate" | "construct" | "call";

export type PtRouterReply =
  | { id: number; ok: true; value?: unknown; marks?: PtRouterInitMarks }
  | { id: number; ok: false; stage: PtRouterFailureStage; error: string };

interface RawPtRouter {
  plan(query: unknown): unknown;
  resolveTime(departureUnix: number): unknown;
  setTransfers(bytes: Uint8Array): void;
}

export interface PtWasmModule {
  PtRouter: new (bytes: Uint8Array, modeStr: string) => RawPtRouter;
  default: (input?: unknown) => Promise<unknown>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Build the worker's request handler. `loadWasm` is the `@pt/wasm` import,
 * injected so tests can supply a fake module.
 *
 * Requests run strictly one at a time, in arrival order. `PtRouter.plan` takes
 * `&mut self` (it reuses one scan state per router), and an `init` that is
 * still awaiting the wasm import must finish before anything reaches the
 * router.
 */
export function createPtRouterHost(
  loadWasm: () => Promise<PtWasmModule>,
): (req: PtRouterRequest) => Promise<PtRouterReply> {
  let router: RawPtRouter | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function init(req: Extract<PtRouterRequest, { op: "init" }>): Promise<PtRouterReply> {
    if (router) return { id: req.id, ok: false, stage: "construct", error: "PtRouter already built" };
    const importStart = epochNow();
    let mod: PtWasmModule;
    try {
      mod = await loadWasm();
    } catch (err) {
      return { id: req.id, ok: false, stage: "import", error: errorText(err) };
    }
    const importEnd = epochNow();
    // wasm-pack `--target web` needs its default export awaited before any
    // other export touches the module (see `buildPtRouter`).
    const instantiateStart = epochNow();
    try {
      await mod.default();
    } catch (err) {
      return { id: req.id, ok: false, stage: "instantiate", error: errorText(err) };
    }
    const instantiateEnd = epochNow();
    const ptnewStart = epochNow();
    try {
      router = new mod.PtRouter(new Uint8Array(req.bytes), req.mode);
    } catch (err) {
      return { id: req.id, ok: false, stage: "construct", error: errorText(err) };
    }
    const ptnewEnd = epochNow();
    return {
      id: req.id,
      ok: true,
      marks: { importStart, importEnd, instantiateStart, instantiateEnd, ptnewStart, ptnewEnd },
    };
  }

  function call(req: Exclude<PtRouterRequest, { op: "init" }>): PtRouterReply {
    if (!router) return { id: req.id, ok: false, stage: "call", error: "PtRouter not built" };
    try {
      switch (req.op) {
        case "plan":
          return { id: req.id, ok: true, value: router.plan(req.query) };
        case "resolveTime":
          return { id: req.id, ok: true, value: router.resolveTime(req.departureUnix) };
        case "setTransfers":
          router.setTransfers(new Uint8Array(req.bytes));
          return { id: req.id, ok: true };
      }
    } catch (err) {
      return { id: req.id, ok: false, stage: "call", error: errorText(err) };
    }
  }

  return (req) => {
    const reply = queue.then(() => (req.op === "init" ? init(req) : call(req)));
    queue = reply;
    return reply;
  };
}
