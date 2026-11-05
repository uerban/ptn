/**
 * Message protocol and request handler for the opt-in arrive-by owner worker
 * (`ptArriveByOwner.worker.ts`, H74). The owner has its own worker, so a
 * running arrive-by request never delays the normal router's `plan` or
 * `resolveTime` (H61). Kept free of `self` so the handler runs in unit tests.
 *
 * One worker hosts one owner for its whole life: `init` attaches the bundle,
 * and the client frees it by terminating the worker, which also returns the
 * arrive-by WASM's linear memory.
 */
import type { ArriveByFeature } from "./temporalArriveByFeature.ts";
import type {
  ArriveByOwnerMarks, ArriveByOwnerOutcome, ArriveByOwnerRequest, ArriveByWorkerOwner,
} from "./temporalArriveByOwner.ts";

export type ArriveByOwnerWorkerRequest =
  | { id: number; op: "init"; bytes: ArrayBuffer; mode: string; city: string }
  /** Sent before the normal router's transfer update: until `replaceTransfers`,
   * every request fails as `TransfersUnavailable`. */
  | { id: number; op: "invalidateTransfers" }
  /** Sent only after the normal router accepted the same bytes. */
  | { id: number; op: "replaceTransfers"; bytes: ArrayBuffer }
  | { id: number; op: "setArriveByEnabled"; enabled: boolean }
  | { id: number; op: "arriveBy"; request: ArriveByOwnerRequest }
  /** H72 warm-up: bound to the generation current when it runs. Dropped if
   * any request has arrived behind it by then; otherwise it builds the owner,
   * and drops its query if a request arrived during that. */
  | { id: number; op: "arriveByWarm"; request: Omit<ArriveByOwnerRequest, "generation"> }
  /** Does nothing itself. Arriving behind a warm-up that has not started, it
   * drops that warm-up, like any other request. */
  | { id: number; op: "arriveByCancelWarm" };

export type ArriveByOwnerWorkerReply =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };

/** Reply value of `arriveByWarm`. `constructed`: the owner was built, the
 * query yielded to a request that arrived meanwhile. */
export type ArriveByWarmReply =
  | { readonly dropped: true; readonly constructed: boolean }
  | { readonly dropped: false; readonly request: ArriveByOwnerRequest; readonly outcome: ArriveByOwnerOutcome };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lets messages that arrived during a long synchronous call be received,
 * and so counted, before the warm-up decides whether to run its query. */
const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The query's outcome with the construction marks of the warm-up's first half. */
function withConstruction(outcome: ArriveByOwnerOutcome, built: Readonly<ArriveByOwnerMarks>): ArriveByOwnerOutcome {
  if (built.constructStart === undefined) return outcome;
  return { ...outcome, marks: Object.freeze({ ...outcome.marks, start: built.start, constructStart: built.constructStart,
    constructEnd: built.constructEnd, constructorCopyBytes: built.constructorCopyBytes }) };
}

/**
 * Build the owner worker's request handler. Requests run strictly one at a
 * time, in arrival order: the owner's methods must not interleave, and the
 * runtime load on the first enable must finish before any request reaches it.
 */
export function createArriveByOwnerHost(
  feature: Pick<ArriveByFeature, "attach" | "load">,
): (req: ArriveByOwnerWorkerRequest) => Promise<ArriveByOwnerWorkerReply> {
  let owner: ArriveByWorkerOwner | null = null;
  let attachError: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // Requests received but not started. A warm-up checks it when its turn
  // comes, so it never delays a request that arrived after it.
  let waiting = 0;

  const attached = (): ArriveByWorkerOwner => {
    if (!owner) throw new Error(attachError ?? "arrive-by owner is not attached");
    return owner;
  };

  async function handle(req: ArriveByOwnerWorkerRequest): Promise<unknown> {
    switch (req.op) {
      case "init":
        if (owner || attachError) throw new Error("arrive-by owner already attached");
        try { owner = feature.attach(new Uint8Array(req.bytes), req.mode, req.city); }
        catch (err) { attachError = `arrive-by owner failed to attach: ${errorText(err)}`; throw new Error(attachError, { cause: err }); }
        return undefined;
      case "invalidateTransfers": {
        const o = attached();
        o.invalidateTransfers();
        return o.snapshot();
      }
      case "replaceTransfers": {
        const o = attached();
        o.replaceTransfers(new Uint8Array(req.bytes));
        return o.snapshot();
      }
      case "setArriveByEnabled": {
        const o = attached();
        // The runtime loads on the first enable, on the queue, so no request
        // can reach the owner before it. A failed load leaves the feature
        // disabled; a later enable retries.
        if (req.enabled === true) {
          try { await feature.load(); }
          catch (err) { throw new Error(`arrive-by runtime failed to load: ${errorText(err)}`, { cause: err }); }
        }
        return o.setEnabled(req.enabled);
      }
      case "arriveBy":
        return attached().run(req.request);
      case "arriveByWarm": {
        const o = attached();
        if (waiting > 0) return { dropped: true, constructed: false } satisfies ArriveByWarmReply;
        const request: ArriveByOwnerRequest = { ...req.request, generation: o.snapshot().generation };
        // Every query needs the owner, so build it first; the likely query
        // then runs only if no request arrived during the build.
        const built = o.construct();
        if (!built.ok) return { dropped: false, request, outcome: built } satisfies ArriveByWarmReply;
        await yieldToMessages();
        if (waiting > 0) return { dropped: true, constructed: true } satisfies ArriveByWarmReply;
        return { dropped: false, request, outcome: withConstruction(o.run(request), built.marks) } satisfies ArriveByWarmReply;
      }
      case "arriveByCancelWarm":
        return undefined;
    }
  }

  return (req) => {
    waiting++;
    const reply = queue.then(async (): Promise<ArriveByOwnerWorkerReply> => {
      waiting--;
      try {
        const value = await handle(req);
        return value === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, value };
      } catch (err) {
        return { id: req.id, ok: false, error: errorText(err) };
      }
    });
    queue = reply;
    return reply;
  };
}
