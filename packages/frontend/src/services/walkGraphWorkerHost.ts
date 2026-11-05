/**
 * Message protocol and request handler for the dedicated worker that owns the
 * walk graph (`walkGraph.worker.ts`). Kept free of `self` so the handler runs
 * unchanged in unit tests and as the in-process fallback where `Worker` does
 * not exist; the worker entry only wires it to `postMessage`.
 *
 * The handler holds at most one city's graph. A `load` for another city frees
 * the old graph before building the new one, so two graphs never share the
 * heap. Freeing a graph does not shrink the wasm heap, though: the client
 * releases that memory by terminating the worker (`WalkGraphClient.destroy`).
 *
 * Requests run one at a time, in arrival order. A `load` that a later `load`
 * overtakes (or `dispose()`) stops at its next await, aborting its fetch, and
 * answers `superseded`.
 */
import type {
  PtWalkGraphHandle,
  WalkGraphLoadStatus,
  WalkProfile,
  WalkRoute,
  WalkWasmModule,
} from "./walkGraphClient.ts";
import {managedWalkGraphArtifacts, type WalkGraphArtifacts, type WalkGraphCandidate} from "./walkGraphOffline.ts";
import type { LatLon } from "@pt/shared";

export type WalkGraphRequest =
  | { id: number; op: "load"; cityId: string }
  | { id: number; op: "route"; cityId: string; from: LatLon; to: LatLon; profile: WalkProfile };

/** Every reply names the city whose graph is loaded after the request, so the
 *  client's view of it never drifts from the handler's. */
export type WalkGraphReply =
  | {
      id: number;
      op: "load";
      status: WalkGraphLoadStatus;
      detail?: string;
      /** The fetch never got a response (offline, DNS, CORS). */
      network?: boolean;
      loadedCity: string | null;
    }
  | { id: number; op: "route"; route: WalkRoute | null; error?: string; loadedCity: string | null };

export interface WalkGraphHostDeps {
  fetch: typeof fetch;
  /** Dependency seam for native fixture tests; production uses managed discovery. */
  artifacts?: WalkGraphArtifacts;
  /** The `@pt/wasm` module, initialised (`__wbg_init` already awaited). */
  loadModule: () => Promise<WalkWasmModule>;
  decompress: (buffer: ArrayBuffer) => Promise<Uint8Array>;
}

export interface WalkGraphHost {
  handle(req: WalkGraphRequest): Promise<WalkGraphReply>;
  /** Free the graph and supersede any load in flight. */
  dispose(): void;
}

/** "PTWG" — a body that already starts with the magic needs no brotli pass
 *  (vite dev, or a server that declares Content-Encoding: br). */
function hasMagic(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x54 && b[2] === 0x57 && b[3] === 0x47;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type LoadOutcome = Pick<Extract<WalkGraphReply, { op: "load" }>, "status" | "detail" | "network">;

export function createWalkGraphHost(deps: WalkGraphHostDeps): WalkGraphHost {
  const artifacts = deps.artifacts ?? managedWalkGraphArtifacts(deps.fetch);
  let graph: PtWalkGraphHandle | null = null;
  let graphCity: string | null = null;
  /** Bumped by every `load` on arrival and by `dispose()`; a load whose ticket
   *  is no longer current has been overtaken. */
  let loadSeq = 0;
  let inFlight: AbortController | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const freeGraph = (): void => {
    graph?.free();
    graph = null;
    graphCity = null;
  };

  async function load(cityId: string, ticket: number, signal: AbortSignal): Promise<LoadOutcome> {
    const superseded = (): boolean => ticket !== loadSeq;
    if (superseded()) return { status: "superseded" };
    if (graph && graphCity === cityId) return { status: "ready" };
    const started = performance.now();
    let candidate: WalkGraphCandidate | null;
    let mod: WalkWasmModule;
    try {
      candidate = await artifacts.load(cityId, signal);
      if (superseded()) return { status: "superseded" };
      if (!candidate) return { status: "missing" };
      mod = await deps.loadModule();
    } catch (err) {
      if (superseded()) return { status: "superseded" };
      return { status: "transient", detail: errorText(err), network: true };
    }
    if (superseded()) return { status: "superseded" };
    async function construct(value: WalkGraphCandidate): Promise<PtWalkGraphHandle> {
      const head = new Uint8Array(value.compressed);
      const bytes = hasMagic(head) ? head : await deps.decompress(value.compressed);
      if (value.resource && bytes.byteLength !== value.resource.decodedBytes) {
        throw new Error("walk graph decoded size mismatch");
      }
      if (superseded()) throw new Error("superseded");
      // Exactly one native graph: old graph is released before construction.
      // Existing guidance never calls this for its already-loaded city.
      freeGraph();
      const next = new mod.PtWalkGraph(bytes);
      if (next.cityId() !== cityId) {
        next.free();
        throw new Error("walk graph city mismatch");
      }
      return next;
    }
    let next: PtWalkGraphHandle;
    try {
      next = await construct(candidate);
    } catch (err) {
      if (superseded()) return { status: "superseded" };
      // A corrupt new release cannot erase the last native-validated offline
      // copy. Retry it sequentially, never constructing two graphs together.
      const fallback = await artifacts.fallback(cityId);
      if (superseded()) return { status: "superseded" };
      if (!fallback || fallback.resource?.sha256 === candidate.resource?.sha256) {
        return { status: "bad", detail: errorText(err) };
      }
      try { next = await construct(fallback); candidate = fallback; }
      catch (fallbackError) {
        if (superseded()) return {status: "superseded"};
        return { status: "bad", detail: errorText(fallbackError) };
      }
    }
    if (superseded()) { next.free(); return { status: "superseded" }; }
    await artifacts.remember(candidate);
    if (superseded()) { next.free(); return { status: "superseded" }; }
    graph = next;
    graphCity = cityId;
    console.info(`[walk-graph] ${cityId} ready in ${Math.round(performance.now() - started)} ms`);
    return { status: "ready" };
  }

  function route(req: Extract<WalkGraphRequest, { op: "route" }>): WalkGraphReply {
    const base = { id: req.id, op: "route" as const, loadedCity: graphCity };
    if (!graph || graphCity !== req.cityId) return { ...base, route: null };
    try {
      return { ...base, route: graph.route(req.from.lat, req.from.lon, req.to.lat, req.to.lon, req.profile) };
    } catch (err) {
      return { ...base, route: null, error: errorText(err) };
    }
  }

  return {
    handle(req) {
      let run: () => Promise<WalkGraphReply> | WalkGraphReply;
      if (req.op === "load") {
        // Overtake the previous load now, not when this one reaches the head
        // of the queue: its fetch stops at once.
        const ticket = ++loadSeq;
        inFlight?.abort();
        const controller = new AbortController();
        inFlight = controller;
        run = async () => {
          const outcome = await load(req.cityId, ticket, controller.signal);
          if (inFlight === controller) inFlight = null;
          return { id: req.id, op: "load", ...outcome, loadedCity: graphCity };
        };
      } else {
        run = () => route(req);
      }
      const reply = queue.then(run);
      queue = reply.catch(() => {});
      return reply;
    },
    dispose() {
      loadSeq++;
      inFlight?.abort();
      inFlight = null;
      freeGraph();
    },
  };
}
