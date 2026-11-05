/**
 * On-device walking routes over the city's walk graph.
 *
 * Graphs come from manager-installed immutable /osm/releases/ URLs discovered
 * through /osm/current/<city>.json. No user position leaves the device. Verified,
 * native-valid compressed bytes are retained in IndexedDB for offline use.
 * Graphs load lazily; guidance pins one graph until its session ends. Idle and
 * foreground adoption resets let the next session discover a newer release.
 *
 * Load outcomes (`WalkGraphLoadStatus`) and what `routeFor` makes of them:
 * - `ready`: the graph is loaded; `routeFor` resolves the route, or null when
 *   the graph has no path between the points.
 * - `missing`: 404, or a dev server's SPA fallback page — the city has no walk
 *   graph. Normal; nothing is reported. `routeFor` resolves null.
 * - `bad`: the artifact itself was rejected (bad brotli, bad bytes, oversized
 *   grid, wrong city). Reported once. `routeFor` resolves null.
 *   Both are remembered for one minute; null route-cache entries expire too,
 *   so newly available releases can recover without reloading the page.
 * - `transient`: network failure, an HTTP error other than 404, or a failed
 *   wasm import. Retried after a per-city backoff (15 s, doubling to 5 min);
 *   until then the call answers `transient` without fetching. Reported at most
 *   once per city per session, and never while the browser is offline.
 * - `superseded`: a load for another city (or `destroy()`) overtook this one.
 * For `transient` and `superseded`, `routeFor` REJECTS with
 * `WalkGraphUnavailableError`: such a result must not be cached as "no walk
 * route" — callers draw the straight line now and ask again later.
 *
 * The graph is decoded and built in a dedicated worker (`walkGraph.worker.ts`,
 * protocol in `walkGraphWorkerHost.ts`): tens of ms on desktop, up to a second
 * on a phone, which on the main thread would freeze guidance start. It is not
 * the router's worker: that one serialises requests behind full plans and is
 * torn down on every bundle swap. Terminating the worker is the only way to
 * give its wasm heap back, so the client does it on `destroy()`, before loading
 * a different city, and after `WALK_GRAPH_IDLE_MS` without a request; the next
 * call starts a fresh one. It also replaces the worker after a rejected load
 * or a routing error, in case a wasm trap left its heap unusable. Where
 * `Worker` does not exist (jsdom, SSR) the same handler runs in-process and
 * can only free the graph. Routing failures are reported once per city per
 * session.
 */
import type { LatLon, LonLat, MobilityProfile } from "@pt/shared";
import { reportError } from "./errorReporter.ts";
import {registerEvictor} from "./storagePolicy.ts";
import type {
  WalkGraphHostDeps,
  WalkGraphHost,
  WalkGraphReply,
  WalkGraphRequest,
} from "./walkGraphWorkerHost.ts";

registerEvictor("walkGraphArtifacts", async () => {
  const {clearWalkGraphStore} = await import("./walkGraphStore.ts");
  await clearWalkGraphStore();
});

export type WalkTurn =
  | "straight"
  | "slight-left"
  | "slight-right"
  | "left"
  | "right"
  | "sharp-left"
  | "sharp-right"
  | "u-turn";

export type WalkStepKind = "depart" | "turn" | "cross" | "stairs" | "arrive";

export interface WalkStep {
  kind: WalkStepKind;
  turn?: WalkTurn;
  /** Street name, or "" for unnamed paths. */
  name: string;
  distanceMeters: number;
  /** Index into `WalkRoute.coords` where the step begins. */
  startIndex: number;
}

export interface WalkRoute {
  coords: LonLat[];
  distanceMeters: number;
  steps: WalkStep[];
}

export type WalkProfile = "default" | "wheelchair";

export function walkProfileFor(profile: MobilityProfile): WalkProfile {
  return profile === "wheelchair" ? "wheelchair" : "default";
}

export interface PtWalkGraphHandle {
  cityId(): string;
  /** null when there is no path, or the coordinates are non-finite / out of range. */
  route(fromLat: number, fromLon: number, toLat: number, toLon: number, profile: WalkProfile): WalkRoute | null;
  free(): void;
}

export interface WalkWasmModule {
  PtWalkGraph: new (bytes: Uint8Array) => PtWalkGraphHandle;
  default: (input?: unknown) => Promise<unknown>;
}

/** The parts of `Worker` the client uses (a fake in tests). */
export interface WalkGraphWorkerLike {
  onmessage: ((event: MessageEvent<WalkGraphReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WalkGraphRequest): void;
  terminate(): void;
}

/** In-process graph (the no-Worker fallback, and tests). */
export interface WalkGraphClientDeps extends WalkGraphHostDeps {
  /** Clock for the retry backoff; defaults to `Date.now`. */
  now?: () => number;
}

/** Graph in a worker. */
export interface WalkGraphWorkerDeps {
  createWorker: () => WalkGraphWorkerLike;
  now?: () => number;
  /** Timer for the idle release; defaults to setTimeout/clearTimeout. */
  timers?: WalkGraphTimers;
}

export interface WalkGraphTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** A worker with no request for this long is terminated, returning its wasm
 *  heap; the next call starts a fresh one. */
export const WALK_GRAPH_IDLE_MS = 5 * 60_000;

export type WalkGraphLoadStatus = "ready" | "missing" | "bad" | "transient" | "superseded";

/** `routeFor` could not answer now, but may later: do not cache this as
 *  "no walk route". */
export class WalkGraphUnavailableError extends Error {
  constructor(
    readonly cityId: string,
    readonly reason: "transient" | "superseded",
  ) {
    super(`walk graph for ${cityId} unavailable (${reason})`);
    this.name = "WalkGraphUnavailableError";
  }
}

const RETRY_FIRST_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type LoadReply = Extract<WalkGraphReply, { op: "load" }>;
type RouteReply = Extract<WalkGraphReply, { op: "route" }>;

/** Where requests go: the worker, or the handler in-process. */
interface WalkGraphPort {
  request(req: WithoutId<WalkGraphRequest>): Promise<WalkGraphReply>;
  /** Drop the held graph before another city loads, as thoroughly as this
   *  port can: a worker is terminated (the heap goes with it); in-process the
   *  handler's own free-before-build is all there is. Pending requests reject
   *  with `PortResetError`. */
  reset(): void;
  setPinned(pinned: boolean): void;
  dispose(): void;
}

/** A request cut off by `reset()` / `dispose()`: superseded, not failed. */
class PortResetError extends Error {}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inProcessPort(deps: WalkGraphHostDeps): WalkGraphPort {
  // Real browsers use the worker. Keep its IndexedDB/validation machinery out
  // of the initial page payload when only the no-Worker fallback needs it.
  let loaded: WalkGraphHost | null = null;
  const host = import("./walkGraphWorkerHost.ts").then(({createWalkGraphHost}) => {
    loaded = createWalkGraphHost(deps);
    if (disposed) loaded.dispose();
    return loaded;
  });
  let disposed = false;
  let nextId = 0;
  return {
    request: async (req) => {
      const handler = await host;
      if (disposed) throw new PortResetError("walk graph port disposed");
      return handler.handle({ ...req, id: nextId++ } as WalkGraphRequest);
    },
    reset: () => {},
    setPinned: () => {},
    dispose: () => { disposed = true; loaded?.dispose(); },
  };
}

/**
 * One worker, an id → pending map (as `buildWorkerPtRouter` does). A worker
 * that dies rejects everything pending and `onDrop` runs (its graph is gone);
 * the port starts a new worker on the next request. So does one left idle for
 * `WALK_GRAPH_IDLE_MS`. `reset()` / `dispose()` terminate it and reject what is
 * pending with `PortResetError`.
 */
function workerPort(
  createWorker: () => WalkGraphWorkerLike,
  onDrop: () => void,
  timers: WalkGraphTimers,
): WalkGraphPort {
  let worker: WalkGraphWorkerLike | null = null;
  let nextId = 0;
  let idle: unknown = null;
  let pinned = false;
  const pending = new Map<number, { resolve: (r: WalkGraphReply) => void; reject: (e: Error) => void }>();

  const stopIdle = (): void => {
    if (idle !== null) timers.clear(idle);
    idle = null;
  };
  const drop = (reason: Error): void => {
    stopIdle();
    worker?.terminate();
    worker = null;
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  };
  const armIdle = (): void => {
    stopIdle();
    if (!worker || pending.size > 0 || pinned) return;
    idle = timers.set(() => {
      idle = null;
      if (pending.size > 0) return;
      drop(new PortResetError("walk graph worker idle"));
      onDrop();
    }, WALK_GRAPH_IDLE_MS);
  };
  const crash = (w: WalkGraphWorkerLike, message: string): void => {
    if (worker !== w) return;
    drop(new Error(message));
    onDrop();
  };
  const start = (): WalkGraphWorkerLike => {
    const w = createWorker();
    w.onmessage = (event) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      entry.resolve(event.data);
      armIdle();
    };
    w.onerror = (event) => {
      event.preventDefault?.();
      crash(w, event.message || "walk graph worker failed");
    };
    w.onmessageerror = () => crash(w, "walk graph worker sent an unreadable reply");
    return w;
  };
  return {
    request(req) {
      stopIdle();
      return new Promise((resolve, reject) => {
        const id = nextId++;
        try {
          worker ??= start();
          pending.set(id, { resolve, reject });
          worker.postMessage({ ...req, id } as WalkGraphRequest);
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
          armIdle();
        }
      });
    },
    reset() {
      drop(new PortResetError("walk graph worker reset"));
    },
    setPinned(value) {
      pinned = value;
      if (pinned) stopIdle();
      else armIdle();
    },
    dispose() {
      drop(new PortResetError("walk graph worker stopped"));
    },
  };
}

function defaultWorker(): WalkGraphWorkerLike {
  return new Worker(new URL("./walkGraph.worker.ts", import.meta.url), { type: "module" }) as WalkGraphWorkerLike;
}

function defaultDeps(): WalkGraphClientDeps | WalkGraphWorkerDeps {
  if (typeof Worker !== "undefined") return { createWorker: defaultWorker };
  return {
    fetch: (input, init) => fetch(input, init),
    loadModule: async () => (await import("./walkGraphFallback.ts")).loadWasm(),
    decompress: async buffer => (await import("./walkGraphFallback.ts")).decompressBrotliBytes(buffer),
  };
}

export class WalkGraphClient {
  private port: WalkGraphPort | null = null;
  private guidanceActive = false;
  /** The city the graph host holds, as of its last reply. */
  private loadedCity: string | null = null;
  private loading: { cityId: string; promise: Promise<WalkGraphLoadStatus> } | null = null;
  /** Brief negative cache; new managed releases must be discoverable. */
  private readonly unusable = new Map<string, {status: "missing" | "bad"; retryAt: number}>();
  private readonly backoff = new Map<string, { retryAt: number; delayMs: number }>();
  /** Cities whose transient failure was already reported; kept across
   *  `destroy()` (once per session). */
  private readonly reportedTransient = new Set<string>();
  /** Cities whose routing failure was already reported (once per session). */
  private readonly reportedRoute = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: WalkGraphClientDeps | WalkGraphWorkerDeps = defaultDeps()) {
    this.now = deps.now ?? Date.now;
  }

  private connect(): WalkGraphPort {
    this.port ??= "createWorker" in this.deps
      ? workerPort(
        this.deps.createWorker,
        () => { this.loadedCity = null; },
        this.deps.timers ?? {
          set: (fn, ms) => setTimeout(fn, ms),
          clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      )
      : inProcessPort(this.deps);
    this.port.setPinned(this.guidanceActive);
    return this.port;
  }

  /** Guidance may include a long transit leg with no graph requests. Keep its
   * exact worker until the session ends instead of adopting midway through it. */
  setGuidanceActive(active: boolean): void {
    this.guidanceActive = active;
    this.port?.setPinned(active);
  }

  isReady(cityId: string): boolean {
    return this.loadedCity === cityId;
  }

  /** Load `cityId`'s graph (once). Resolves false unless it is ready (see the
   *  module comment for why); never rejects. */
  async ensureCity(cityId: string): Promise<boolean> {
    return (await this.loadCity(cityId)) === "ready";
  }

  /** Load `cityId`'s graph and say how that went; never rejects. */
  loadCity(cityId: string): Promise<WalkGraphLoadStatus> {
    if (this.isReady(cityId)) return Promise.resolve("ready");
    const known = this.unusable.get(cityId);
    if (known && this.now() < known.retryAt) return Promise.resolve(known.status);
    this.unusable.delete(cityId);
    if (this.loading?.cityId === cityId) return this.loading.promise;
    const wait = this.backoff.get(cityId);
    if (wait && this.now() < wait.retryAt) return Promise.resolve("transient");
    const port = this.connect();
    // Another city's graph is held: drop it (and, with a worker, its heap)
    // before this one loads, so switching back from tricity to vilnius does
    // not keep tricity's peak.
    if (this.loadedCity !== null) {
      port.reset();
      this.loadedCity = null;
    }
    const promise = port
      .request({ op: "load", cityId })
      .then(
        (reply) => reply as LoadReply,
        (err: unknown): LoadReply => ({
          id: -1,
          op: "load",
          status: err instanceof PortResetError ? "superseded" : "transient",
          detail: errorText(err),
          loadedCity: null,
        }),
      )
      .then((reply) => {
        // destroy() ran meanwhile: whatever this answered is gone with it.
        if (this.port !== port) return "superseded" as const;
        this.loadedCity = reply.loadedCity;
        return this.settle(cityId, reply);
      })
      .finally(() => {
        if (this.loading?.promise === promise) this.loading = null;
      });
    this.loading = { cityId, promise };
    return promise;
  }

  /** Record one attempt's outcome: remember, back off, report. */
  private settle(cityId: string, outcome: LoadReply): WalkGraphLoadStatus {
    const { status } = outcome;
    if (status === "ready") this.backoff.delete(cityId);
    if (status === "missing" || status === "bad") this.unusable.set(cityId, {status, retryAt: this.now() + 60_000});
    if (status === "bad") {
      this.report(new Error(outcome.detail ?? "walk graph rejected"), cityId);
      this.recycle();
    }
    if (status === "transient") {
      const prev = this.backoff.get(cityId);
      const delayMs = prev ? Math.min(prev.delayMs * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
      this.backoff.set(cityId, { retryAt: this.now() + delayMs, delayMs });
      const offline = outcome.network === true && globalThis.navigator?.onLine === false;
      if (!offline && !this.reportedTransient.has(cityId)) {
        this.reportedTransient.add(cityId);
        this.report(new Error(outcome.detail ?? "walk graph load failed"), cityId);
      }
    }
    return status;
  }

  private report(err: Error, cityId: string): void {
    reportError(err, { context: { feature: "walk-graph", cityId } });
  }

  /** Route on the loaded graph; `stale` when it no longer holds `cityId`. */
  private async routeOnce(
    cityId: string, from: LatLon, to: LatLon, profile: WalkProfile,
  ): Promise<{ route: WalkRoute | null; stale: boolean }> {
    const port = this.connect();
    const reply = (await port.request({ op: "route", cityId, from, to, profile })) as RouteReply;
    if (this.port !== port) return { route: null, stale: true };
    this.loadedCity = reply.loadedCity;
    if (reply.error) {
      this.reportRouteFailure(new Error(reply.error), cityId);
      this.recycle();
    }
    return { route: reply.route, stale: reply.loadedCity !== cityId };
  }

  /** A wasm trap may leave the module's heap inconsistent (the build aborts on
   *  panic), so after a rejected load or a routing error the worker is
   *  replaced; the next call starts a fresh one and reloads the graph. Only
   *  other requests still pending are superseded; the failing one has already
   *  been answered. A `bad` city is remembered, so this does not loop. */
  private recycle(): void {
    this.port?.reset();
    this.loadedCity = null;
  }

  private reportRouteFailure(err: Error, cityId: string): void {
    if (this.reportedRoute.has(cityId)) return;
    this.reportedRoute.add(cityId);
    this.report(err, cityId);
  }

  /** Route on an already-loaded graph; null when `cityId` is not loaded, there
   *  is no path, or routing failed. Never rejects. */
  async route(cityId: string, from: LatLon, to: LatLon, profile: WalkProfile): Promise<WalkRoute | null> {
    if (!this.isReady(cityId)) return null;
    try {
      return (await this.routeOnce(cityId, from, to, profile)).route;
    } catch (err) {
      if (!(err instanceof PortResetError)) {
        this.reportRouteFailure(err instanceof Error ? err : new Error(String(err)), cityId);
      }
      return null;
    }
  }

  /** The walking route, or null when there is none to have (no path, or the
   *  city has no usable graph). Rejects with `WalkGraphUnavailableError` when
   *  the graph could not be loaded now but may load later. */
  async routeFor(cityId: string, from: LatLon, to: LatLon, profile: WalkProfile): Promise<WalkRoute | null> {
    const status = await this.loadCity(cityId);
    if (status === "transient" || status === "superseded") throw new WalkGraphUnavailableError(cityId, status);
    if (status !== "ready") return null;
    let result: { route: WalkRoute | null; stale: boolean };
    try {
      result = await this.routeOnce(cityId, from, to, profile);
    } catch (err) {
      if (err instanceof PortResetError) throw new WalkGraphUnavailableError(cityId, "superseded");
      this.reportRouteFailure(err instanceof Error ? err : new Error(String(err)), cityId);
      throw new WalkGraphUnavailableError(cityId, "transient"); // the worker died
    }
    // Another city replaced this one between the load and the route.
    if (result.stale) throw new WalkGraphUnavailableError(cityId, "superseded");
    return result.route;
  }

  /** Drop the graph and forget missing cities. With a worker, terminates it:
   *  the only way to return its wasm heap. The next call starts a new one. */
  destroy(): void {
    this.port?.dispose();
    this.port = null;
    this.loading = null;
    this.loadedCity = null;
    this.unusable.clear();
    this.backoff.clear();
  }
}

export const walkGraphClient = new WalkGraphClient();
