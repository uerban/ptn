import type { RaptorQuery, RaptorItinerary, TransportMode } from "@pt/shared";
import { engineMobilityProfile, type EngineMobilityProfile } from "@pt/shared/routing";
import { PATTERN_MODE } from "@pt/shared/raptor";
import type { PtRouterReply, PtRouterRequest } from "./ptRouterWorkerHost.ts";
import { createArriveByLink, createRouterWorker } from "./ptRouterWorkerEntry.ts";
import type { ArriveByChannel } from "./temporalArriveByClient.ts";

export class PtWasmImportError extends Error {
  constructor(cause: unknown) {
    super(`pt-wasm dynamic import failed: ${String(cause)}`);
    this.name = "PtWasmImportError";
    (this as { cause?: unknown }).cause = cause;
  }
}
export class PtWasmInitError extends Error {
  constructor(cause: unknown) {
    super(`PtRouter construction failed: ${String(cause)}`);
    this.name = "PtWasmInitError";
    (this as { cause?: unknown }).cause = cause;
  }
}
export class PtWasmQueryError extends Error {
  constructor(cause: unknown) {
    super(`PtRouter.plan() failed: ${String(cause)}`);
    this.name = "PtWasmQueryError";
    (this as { cause?: unknown }).cause = cause;
  }
}
export class PtWasmTimeError extends Error {
  constructor(cause: unknown) {
    super(`PtRouter.resolveTime() failed: ${String(cause)}`);
    this.name = "PtWasmTimeError";
    (this as { cause?: unknown }).cause = cause;
  }
}
export class PtWasmTransfersError extends Error {
  constructor(cause: unknown) {
    super(`PtRouter.setTransfers() failed: ${String(cause)}`);
    this.name = "PtWasmTransfersError";
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Thrown by the on-device planning boundary when no live `PtRouter` can be
 * resolved for the search's city/generation — the bytes fetch failed, the
 * build is terminally `failed`, or the bounded init wait expired. There is no
 * second local engine to fall back to: the search surfaces a typed engine
 * failure (`classifyEngineFailure` → `"init"`) and produces no itineraries.
 */
export class PtEngineMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtEngineMisconfiguredError";
  }
}

/**
 * Thrown by `gtfsDataStore.ensureWasmReady` (and re-thrown by `planOnDevice`)
 * when a `reset()` / city-switch / refresh bumped the init generation while a
 * wasm build was in flight — the resolved router is for an OBSOLETE
 * city/generation. This is NOT an engine failure: a superseding search is
 * already in flight for the new generation, so the result must be DROPPED
 * rather than published over the old city/query.
 */
export class StaleWasmInitError extends Error {
  constructor(message = "stale wasm init result") {
    super(message);
    this.name = "StaleWasmInitError";
  }
}

/**
 * Coerce a TransportMode to a SINGLE canonical base route_type. The engine
 * forward-maps the int to its Mode and excludes the whole family (spec A5 ),
 * so [11] (TROLLEYBUS) covers Vilnius 800, [1] (METRO) covers 401, etc. Every
 * base type round-trips: routeTypeToMode(base) === mode (tested). Tolerant:
 * unknown / legacy / leg modes (WALK, BIKE, a stale "CABLE_CAR") coerce to no
 * exclusion rather than throwing.
 */
export function transportModeToRouteTypes(mode: TransportMode): number[] {
  switch (mode) {
    case "TRAM": return [0];
    case "METRO": return [1];
    case "RAIL": return [2];
    case "BUS": return [3];
    case "FERRY": return [4];
    case "CABLE_TRAM": return [5];
    case "AERIAL": return [6];
    case "FUNICULAR": return [7];
    case "TROLLEYBUS": return [11];
    case "OTHER": return [1700];
    default:
      return [];
  }
}

/**
 * One absolute departure instant resolved against the bundle's service-day
 * origins (`PtRouter.resolveTime`). `departureSecs` is GTFS `Time` in the
 * `serviceDate` frame, the frame the engine plans and reports results in.
 */
export interface ResolvedServiceTime {
  serviceDate: string;
  timeOriginUnix: number;
  departureSecs: number;
}

/**
 * The on-device router. Calls are async because the router normally lives in
 * a dedicated worker (`ptRouter.worker.ts`), so a search never blocks the main
 * thread. `free()` is idempotent; calls already in flight still settle, later
 * calls reject.
 */
export interface PtRouterHandle {
  plan(q: WasmQuery): Promise<WasmItinerary[]>;
  resolveTime(departureUnix: number): Promise<ResolvedServiceTime>;
  setTransfers(bytes: Uint8Array): Promise<void>;
  free(): void;
  isAlive(): boolean;
  /** The arrive-by owner, in its own worker (H74). Only an arrive-by
   * build has it; never in-process. */
  readonly arriveBy?: ArriveByChannel;
}
/** The raw wasm-bindgen `PtRouter` as the in-process path calls it. */
interface RawPtRouter {
  plan(q: WasmQuery): WasmItinerary[];
  resolveTime(departureUnix: number): ResolvedServiceTime;
  setTransfers(bytes: Uint8Array): void;
  free(): void;
  isAlive(): boolean;
}
interface WasmQuery {
  entryStops: { stopId: string; walkSecs: number }[];
  exitStops: { stopId: string; walkSecs: number }[];
  date: string;
  departureSecs: number;
  maxRounds?: number;
  mobilityProfile?: EngineMobilityProfile;
  excludedModes?: number[];
  excludedRouteIds?: string[];
  walkSpeedMps?: number;
  minTransferSecs?: number;
}
type WasmItinerary = RaptorItinerary;

/**
 * Thin TS wrapper around the raw `PtRouter` wasm-bindgen handle, used when
 * the router runs in-process (no `Worker`; see `buildPtRouter`). Two
 * adapter-level guarantees the raw handle doesn't provide on its own:
 *
 * 1. `free()` is centrally idempotent — repeated calls collapse to a
 *    single underlying `raw.free()`. P5's `manual_free` IS idempotent
 *    on the Rust side (Cell<bool> flag flip), but a future regression
 *    in the wasm contract would silently propagate; the TS gate catches
 *    it at the adapter layer.
 * 2. `plan()` post-free throws `PtWasmQueryError` deterministically
 *    (without depending on the wasm side noticing). `planWithWasm`'s
 *    pre-call `isAlive()` check is the fast path; this is the
 *    correctness backstop.
 */
function wrapPtRouter(raw: RawPtRouter): PtRouterHandle {
  let alive = true;
  return {
    async plan(q: WasmQuery): Promise<WasmItinerary[]> {
      if (!alive) throw new PtWasmQueryError(new Error("PtRouter has been freed"));
      return raw.plan(q);
    },
    // Symmetric to `plan` on the post-free contract: a freed handle throws a
    // typed error rather than reaching into the freed wasm object.
    async resolveTime(departureUnix: number): Promise<ResolvedServiceTime> {
      if (!alive) throw new PtWasmTimeError(new Error("PtRouter has been freed"));
      try {
        return raw.resolveTime(departureUnix);
      } catch (err) {
        throw new PtWasmTimeError(err);
      }
    },
    // Forwards the raw bytes unmodified. Symmetric to `plan` on the
    // post-free contract: a `setTransfers` call after `free()` throws
    // a typed error rather than reaching into the freed handle.
    async setTransfers(bytes: Uint8Array): Promise<void> {
      if (!alive) {
        throw new PtWasmTransfersError(new Error("PtRouter has been freed"));
      }
      raw.setTransfers(bytes);
    },
    free(): void {
      if (!alive) return;
      alive = false;
      raw.free();
    },
    isAlive(): boolean {
      return alive && raw.isAlive();
    },
  };
}

/**
 * Performance-timeline marks emitted around the wasm-only critical path for the e2e cold-start
 * budget spec (panel perf #3 / engineer #3). The four `ptn:wasm:*` measure pairs partition the
 * cold-start latency into:

 *
 *   - `import`      — dynamic `import("@pt/wasm")` (network + parse of the
 *                     wasm-bindgen JS shim; wasm bytes themselves stream
 *                     in via `instantiate`). On the worker path it starts
 *                     when the worker is spawned, so it also covers the
 *                     worker script load.
 *   - `instantiate` — wasm-bindgen's `__wbindgen_start` runs here. Only
 *                     emitted on the first call per page; later calls hit
 *                     the cached module and we re-mark with the cached
 *                     duration (~0) so the e2e read-side always sees the
 *                     four-pair set.
 *   - `ptnew`       — `new PtRouter(bytes)` — PTB decode + Index::build
 *                     inside Rust. This is the heaviest single hop on
 *                     anything bigger than the tiny fixture.
 *   - `firstplan`   — emitted from `planWithWasm` on the first call (see
 *                     marker below), not here. Listed for completeness.
 *
 * Marks are always written to the PAGE's timeline. The worker stamps its
 * steps in epoch milliseconds and `buildWorkerPtRouter` re-bases them, since a
 * worker's own `performance` timeline is invisible to the page.
 *
 * `buildPtRouter` is the only on-device router constructor, so the marks
 * partition every on-device search's cold start. It builds the router in a
 * dedicated worker wherever `Worker` exists (every supported browser), and
 * in-process otherwise (jsdom, SSR).
 */
export async function buildPtRouter(bytes: Uint8Array, city?: string): Promise<PtRouterHandle> {
  return typeof Worker === "undefined"
    ? buildInProcessPtRouter(bytes)
    : buildWorkerPtRouter(bytes, city);
}

async function buildInProcessPtRouter(bytes: Uint8Array): Promise<PtRouterHandle> {
  // pt-wasm is built with `wasm-pack --target web`, which requires the
  // consumer to MANUALLY invoke the default-exported `__wbg_init` before
  // any other export touches the wasm module. Without this call, the
  // module-level `wasm` binding inside the generated `pt_wasm.js` shim
  // stays `undefined`; the first call into the module (`new PtRouter(...)`
  // → `wasm.__wbindgen_add_to_stack_pointer(...)`) throws TypeError
  // synchronously, the fire-and-forget `startEagerInitForCity` swallows
  // it, and `ptRouter` stays null — so the planning boundary
  // (`wasmPlanner.ts`) throws `PtEngineMisconfiguredError` and the UI
  // shows engine-error instead of itineraries. We host-init
  // here so every caller path (initOrSwapPtRouter + reinstantiateFromCache)
  // gets it. wasm-bindgen dedupes — second call resolves instantly.
  // `ptRouterWorkerHost.ts` does the same inside the worker.
  let mod: {
    PtRouter: new (b: Uint8Array, modeStr: string) => RawPtRouter;
    default: (input?: unknown) => Promise<unknown>;
  };
  performance.mark("ptn:wasm:import:start");
  try {
    mod = await import("@pt/wasm") as typeof mod;
  } catch (err) {
    throw new PtWasmImportError(err);
  }
  performance.mark("ptn:wasm:import:end");

  // wasm-bindgen `--target web` manual init. First call streams the
  // `.wasm` bytes + `WebAssembly.instantiate`s them; later calls are
  // cached and resolve effectively instantly. The mark pair keeps the
  // perf-timeline shape stable for the e2e cold-start spec.
  performance.mark("ptn:wasm:instantiate:start");
  try {
    await mod.default();
  } catch (err) {
    throw new PtWasmInitError(err);
  }
  performance.mark("ptn:wasm:instantiate:end");

  performance.mark("ptn:wasm:ptnew:start");
  try {
    const handle = wrapPtRouter(new mod.PtRouter(bytes, PATTERN_MODE));
    performance.mark("ptn:wasm:ptnew:end");
    return handle;
  } catch (err) {
    throw new PtWasmInitError(err);
  }
}

/** Write a page-timeline mark at an epoch-millisecond instant from a worker. */
function markAtEpoch(name: string, epochMs: number): void {
  performance.mark(name, { startTime: Math.max(0, epochMs - performance.timeOrigin) });
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * Build the router inside a dedicated worker that owns it for life. Requests
 * are answered in order (the worker serialises them), so concurrent searches
 * queue rather than interleave.
 *
 * Errors keep the shapes the in-process path produces: a failed init throws
 * `PtWasmImportError` / `PtWasmInitError` by stage, a failed `plan` rejects
 * with a plain `Error` for `planWithWasm` to wrap, `resolveTime` with
 * `PtWasmTimeError`, `setTransfers` with a plain `Error`.
 *
 * `free()` stops new calls at once but terminates the worker only after the
 * calls already in flight settle, so a hot swap (`swapPtRouter`) never cuts off
 * a running search. Terminating drops the worker's whole wasm heap. A worker
 * that dies (`error` / `messageerror`) rejects everything pending and reports
 * `isAlive() === false`, which the visibility-resume guard rebuilds from.
 */
async function buildWorkerPtRouter(bytes: Uint8Array, city?: string): Promise<PtRouterHandle> {
  performance.mark("ptn:wasm:import:start");
  let worker: Worker;
  try {
    worker = createRouterWorker();
  } catch (err) {
    throw new PtWasmImportError(err);
  }

  const pending = new Map<number, {
    resolve: (reply: PtRouterReply) => void;
    reject: (err: Error) => void;
  }>();
  let nextId = 0;
  let freed = false;
  let crashed: Error | null = null;

  const terminateIfDrained = (): void => {
    if (freed && pending.size === 0) worker.terminate();
  };
  const crash = (message: string): void => {
    if (crashed) return;
    crashed = new Error(message);
    worker.terminate();
    for (const entry of pending.values()) entry.reject(crashed);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<PtRouterReply>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    entry.resolve(event.data);
    terminateIfDrained();
  };
  worker.onerror = (event) => {
    event.preventDefault();
    crash(event.message || "pt-wasm router worker failed");
  };
  worker.onmessageerror = () => crash("pt-wasm router worker sent an unreadable reply");

  const send = (req: WithoutId<PtRouterRequest>, transfer: Transferable[] = []): Promise<PtRouterReply> => {
    if (crashed) return Promise.reject(crashed);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...req, id }, transfer);
      } catch (err) {
        // An uncloneable request never reaches the worker; don't leave it
        // pending, or a later free() would wait on it forever.
        pending.delete(id);
        reject(err);
      }
    });
  };
  // The caller keeps its bytes (they may be cached); the worker gets a copy
  // it owns outright, moved rather than cloned a second time.
  const ownedCopy = (view: Uint8Array): ArrayBuffer => view.slice().buffer;

  const initBytes = ownedCopy(bytes);
  let init: PtRouterReply;
  try {
    init = await send({ op: "init", bytes: initBytes, mode: PATTERN_MODE }, [initBytes]);
  } catch (err) {
    // The worker died before answering, most likely because its script
    // failed to load: the worker-path equivalent of a failed import.
    throw new PtWasmImportError(err);
  }
  if (!init.ok) {
    worker.terminate();
    const cause = new Error(init.error);
    throw init.stage === "import" ? new PtWasmImportError(cause) : new PtWasmInitError(cause);
  }
  if (init.marks) {
    markAtEpoch("ptn:wasm:import:end", init.marks.importEnd);
    markAtEpoch("ptn:wasm:instantiate:start", init.marks.instantiateStart);
    markAtEpoch("ptn:wasm:instantiate:end", init.marks.instantiateEnd);
    markAtEpoch("ptn:wasm:ptnew:start", init.marks.ptnewStart);
    markAtEpoch("ptn:wasm:ptnew:end", init.marks.ptnewEnd);
  }

  const call = async (
    req: WithoutId<PtRouterRequest>,
    wrap: (cause: unknown) => Error,
    transfer?: Transferable[],
  ): Promise<unknown> => {
    if (freed) throw wrap(new Error("PtRouter has been freed"));
    let reply: PtRouterReply;
    try {
      reply = await send(req, transfer);
    } catch (err) {
      throw wrap(err);
    }
    if (!reply.ok) throw wrap(new Error(reply.error));
    return reply.value;
  };
  const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));
  // Opt-in build only: the arrive-by owner's worker, bound to the city. It
  // starts with the router and fetches its WASM on the first enable.
  const arriveBy = city ? createArriveByLink?.({ bytes, mode: PATTERN_MODE, city }) : undefined;

  return {
    async plan(q: WasmQuery): Promise<WasmItinerary[]> {
      if (freed) throw new PtWasmQueryError(new Error("PtRouter has been freed"));
      return await call({ op: "plan", query: q }, asError) as WasmItinerary[];
    },
    async resolveTime(departureUnix: number): Promise<ResolvedServiceTime> {
      return await call(
        { op: "resolveTime", departureUnix },
        (cause) => new PtWasmTimeError(cause),
      ) as ResolvedServiceTime;
    },
    async setTransfers(bytes: Uint8Array): Promise<void> {
      if (freed) throw new PtWasmTransfersError(new Error("PtRouter has been freed"));
      const buffer = ownedCopy(bytes);
      // The owner drops its transfers first and gets the new ones only once
      // the router accepted them: it never searches with other transfers
      // than the router's.
      arriveBy?.invalidateTransfers();
      await call({ op: "setTransfers", bytes: buffer }, asError, [buffer]);
      await arriveBy?.replaceTransfers(bytes);
    },
    free(): void {
      if (freed) return;
      freed = true;
      arriveBy?.free();
      terminateIfDrained();
    },
    isAlive(): boolean {
      return !freed && !crashed;
    },
    ...(arriveBy ? { arriveBy: arriveBy.channel } : {}),
  };
}

// Process-local "have we marked the first plan() yet?" flag (cold-start spec). Stays page-local —
// each Playwright test that opens a fresh context gets a fresh module instance.
let firstPlanMarked = false;

export async function planWithWasm(
  router: PtRouterHandle,
  query: RaptorQuery,
  date: string,
): Promise<RaptorItinerary[]> {
  // Panel qa HIGH: plan() after free() must throw a typed error.
  if (!router.isAlive()) {
    throw new PtWasmQueryError(new Error("PtRouter has been freed"));
  }
  const coerced = query.excludedModes?.flatMap(transportModeToRouteTypes);
  const wasmQuery: WasmQuery = {
    entryStops: query.entryStops,
    exitStops: query.exitStops,
    date,
    departureSecs: query.departureSecs,
    maxRounds: query.maxRounds,
    mobilityProfile: engineMobilityProfile(query.mobilityProfile),
    ...(query.walkSpeedMps !== undefined ? { walkSpeedMps: query.walkSpeedMps } : {}),
    ...(query.minTransferSecs !== undefined ? { minTransferSecs: query.minTransferSecs } : {}),
    // Empty array means "no exclusion" — pass undefined to match the
    // wasm-side default (panel qa MEDIUM: pinned contract).
    ...(coerced && coerced.length > 0 ? { excludedModes: coerced } : {}),
    ...(query.excludedRouteIds?.length ? { excludedRouteIds: query.excludedRouteIds } : {}),
  };
  const isFirst = !firstPlanMarked;
  if (isFirst) performance.mark("ptn:wasm:firstplan:start");
  try {
    const result = await router.plan(wasmQuery);
    if (isFirst) {
      performance.mark("ptn:wasm:firstplan:end");
      firstPlanMarked = true;
    }
    return result;
  } catch (err) {
    throw new PtWasmQueryError(err);
  }
}
