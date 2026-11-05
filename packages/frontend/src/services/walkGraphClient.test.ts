import {fixtureGraphArtifacts} from "./walkGraphFixtureArtifacts.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WALK_GRAPH_IDLE_MS,
  WalkGraphClient,
  WalkGraphUnavailableError,
  walkProfileFor,
  type WalkGraphWorkerLike,
  type WalkRoute,
} from "./walkGraphClient.ts";
import { createWalkGraphHost, type WalkGraphReply, type WalkGraphRequest } from "./walkGraphWorkerHost.ts";
import { reportError } from "./errorReporter.ts";

vi.mock("./errorReporter.ts", () => ({ reportError: vi.fn() }));

const ROUTE: WalkRoute = {
  coords: [[25.28, 54.68], [25.281, 54.681]],
  distanceMeters: 130,
  steps: [
    { kind: "depart", name: "Pylimo g.", distanceMeters: 130, startIndex: 0 },
    { kind: "arrive", name: "", distanceMeters: 0, startIndex: 1 },
  ],
};

const PTWG = new Uint8Array([0x50, 0x54, 0x57, 0x47, 1, 0]);

function makeGraph(cityId: string) {
  return { cityId: () => cityId, route: vi.fn(() => ROUTE), free: vi.fn() };
}

function setup(opts: { status?: number; body?: Uint8Array<ArrayBuffer>; cityId?: string } = {}) {
  const graphs: ReturnType<typeof makeGraph>[] = [];
  const fetchMock = vi.fn(async (_url: string) =>
    new Response(opts.status === 404 ? null : (opts.body ?? PTWG), { status: opts.status ?? 200 }),
  );
  const decompress = vi.fn(async () => PTWG);
  const PtWalkGraph = vi.fn(function (this: unknown, _bytes: Uint8Array) {
    const g = makeGraph(opts.cityId ?? "vilnius");
    graphs.push(g);
    return g;
  });
  const clock = { t: 1_000_000 };
  const client = new WalkGraphClient({
    fetch: fetchMock as unknown as typeof fetch,
    artifacts: fixtureGraphArtifacts(fetchMock as unknown as typeof fetch),
    decompress,
    loadModule: async () => ({ PtWalkGraph: PtWalkGraph as never, default: async () => undefined }),
    now: () => clock.t,
  });
  return { client, fetchMock, decompress, PtWalkGraph, graphs, clock };
}

describe("walkGraphClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps mobility profiles", () => {
    expect(walkProfileFor("wheelchair")).toBe("wheelchair");
    expect(walkProfileFor("vision_impaired")).toBe("default");
    expect(walkProfileFor("default")).toBe("default");
  });

  it("loads once per city and routes", async () => {
    const { client, fetchMock, PtWalkGraph } = setup();
    const [a, b] = await Promise.all([client.ensureCity("vilnius"), client.ensureCity("vilnius")]);
    expect(a && b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(PtWalkGraph).toHaveBeenCalledTimes(1);
    expect(await client.route("vilnius", { lat: 54.68, lon: 25.28 }, { lat: 54.681, lon: 25.281 }, "default")).toEqual(ROUTE);
    expect(await client.route("tricity", { lat: 0, lon: 0 }, { lat: 0, lon: 0 }, "default")).toBeNull();
  });

  it("skips decompression when the server already decoded the body", async () => {
    const { client, decompress } = setup({ body: PTWG });
    await client.ensureCity("vilnius");
    expect(decompress).not.toHaveBeenCalled();
  });

  it("decompresses an opaque .br body", async () => {
    const { client, decompress } = setup({ body: new Uint8Array([0x1b, 0x2c]) });
    await client.ensureCity("vilnius");
    expect(decompress).toHaveBeenCalledTimes(1);
  });

  it("remembers a 404 as a city without a walk graph", async () => {
    const { client, fetchMock } = setup({ status: 404 });
    expect(await client.ensureCity("krakow")).toBe(false);
    expect(await client.ensureCity("krakow")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a missing graph after the negative-cache TTL", async () => {
    const {client, fetchMock, clock} = setup({status: 404});
    expect(await client.ensureCity("vilnius")).toBe(false);
    clock.t += 60_001;
    fetchMock.mockResolvedValueOnce(new Response(PTWG));
    expect(await client.ensureCity("vilnius")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses an artifact for another city", async () => {
    const { client, graphs } = setup({ cityId: "tricity" });
    expect(await client.ensureCity("vilnius")).toBe(false);
    expect(graphs[0]!.free).toHaveBeenCalled();
  });

  it("frees the previous city's graph on switch", async () => {
    const s = setup();
    await s.client.ensureCity("vilnius");
    const first = s.graphs[0]!;
    // Second load answers as tricity.
    s.PtWalkGraph.mockImplementationOnce(function () {
      const g = makeGraph("tricity");
      s.graphs.push(g);
      return g;
    });
    expect(await s.client.ensureCity("tricity")).toBe(true);
    expect(first.free).toHaveBeenCalled();
    expect(s.client.isReady("vilnius")).toBe(false);
    expect(s.client.isReady("tricity")).toBe(true);
  });

  it("routeFor loads then routes; destroy frees", async () => {
    const { client, graphs } = setup();
    expect(await client.routeFor("vilnius", { lat: 54.68, lon: 25.28 }, { lat: 54.681, lon: 25.281 }, "wheelchair")).toEqual(ROUTE);
    expect(graphs[0]!.route).toHaveBeenCalledWith(54.68, 25.28, 54.681, 25.281, "wheelchair");
    client.destroy();
    expect(graphs[0]!.free).toHaveBeenCalled();
    expect(client.isReady("vilnius")).toBe(false);
  });

  it("returns null instead of throwing when the wasm route throws", async () => {
    const { client, graphs } = setup();
    await client.ensureCity("vilnius");
    graphs[0]!.route.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(await client.route("vilnius", { lat: 0, lon: 0 }, { lat: 0, lon: 0 }, "default")).toBeNull();
  });

  it("treats an HTML body (dev SPA fallback) as a city without a walk graph", async () => {
    const s = setup();
    s.fetchMock.mockImplementation(async () =>
      new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(await s.client.ensureCity("paris")).toBe(false);
    expect(await s.client.ensureCity("paris")).toBe(false);
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    expect(s.PtWalkGraph).not.toHaveBeenCalled();
  });

  it("does not refetch an artifact the wasm rejected", async () => {
    const s = setup();
    s.PtWalkGraph.mockImplementation(function () { throw new Error("TooLarge"); });
    expect(await s.client.ensureCity("vilnius")).toBe(false);
    expect(await s.client.ensureCity("vilnius")).toBe(false);
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient HTTP failure only after the backoff", async () => {
    const s = setup();
    s.fetchMock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    expect(await s.client.loadCity("vilnius")).toBe("transient");
    // Inside the backoff window: answered without a fetch.
    expect(await s.client.loadCity("vilnius")).toBe("transient");
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    s.clock.t += 15_000;
    expect(await s.client.ensureCity("vilnius")).toBe(true);
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doubles the backoff up to five minutes", async () => {
    const s = setup();
    s.fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const waits: number[] = [];
    await s.client.loadCity("vilnius");
    for (let i = 0; i < 7; i++) {
      const before = s.fetchMock.mock.calls.length;
      let waited = 0;
      while (s.fetchMock.mock.calls.length === before) {
        s.clock.t += 1_000;
        waited += 1_000;
        await s.client.loadCity("vilnius");
      }
      waits.push(waited);
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it("reports a transient failure at most once per city", async () => {
    const s = setup();
    s.fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    await s.client.loadCity("vilnius");
    s.clock.t += 15_000;
    await s.client.loadCity("vilnius");
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed fetch while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const s = setup();
      s.fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
      expect(await s.client.loadCity("vilnius")).toBe("transient");
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routeFor rejects on a transient failure and resolves null for a missing city", async () => {
    const s = setup();
    s.fetchMock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const a = { lat: 54.68, lon: 25.28 };
    await expect(s.client.routeFor("vilnius", a, a, "default")).rejects.toBeInstanceOf(WalkGraphUnavailableError);
    s.fetchMock.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    expect(await s.client.routeFor("krakow", a, a, "default")).toBeNull();
  });

  it("a load overtaken by another city is not remembered as missing", async () => {
    // Each body names its city after the magic; the fake graph reads it back.
    const body = (city: string) => new Uint8Array([...PTWG.subarray(0, 4), ...new TextEncoder().encode(city)]);
    let vilniusStarted!: () => void;
    const started = new Promise<void>((r) => { vilniusStarted = r; });
    let vilniusFetches = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("vilnius") && vilniusFetches++ === 0) {
        // The first vilnius download stalls until it is aborted.
        vilniusStarted();
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return new Response(body(url.includes("vilnius") ? "vilnius" : "tricity"));
    });
    const client = new WalkGraphClient({
      fetch: fetchMock as unknown as typeof fetch,
    artifacts: fixtureGraphArtifacts(fetchMock as unknown as typeof fetch),
      decompress: vi.fn(),
      loadModule: async () => ({
        PtWalkGraph: function (bytes: Uint8Array) {
          return makeGraph(new TextDecoder().decode(bytes.subarray(4)));
        } as never,
        default: async () => undefined,
      }),
    });
    const a = { lat: 54.68, lon: 25.28 };
    const first = client.routeFor("vilnius", a, a, "default");
    const firstSettled = first.catch((e: unknown) => e);
    await started;
    expect(await client.ensureCity("tricity")).toBe(true);
    const err = await firstSettled;
    expect(err).toBeInstanceOf(WalkGraphUnavailableError);
    expect((err as WalkGraphUnavailableError).reason).toBe("superseded");
    expect(client.isReady("tricity")).toBe(true);
    // Asked again, it loads for real.
    expect(await client.routeFor("vilnius", a, a, "default")).toEqual(ROUTE);
    expect(client.isReady("vilnius")).toBe(true);
    expect(vilniusFetches).toBe(2);
    expect(reportError).not.toHaveBeenCalled();
  });
});

/**
 * Stand-in for the dedicated worker: runs the real handler over fake deps and
 * crosses the boundary with `structuredClone`, asynchronously, as postMessage
 * would.
 */
/** The fake worker's artifact names its city after the magic. */
const cityBody = (url: string) =>
  new Uint8Array([...PTWG.subarray(0, 4), ...new TextEncoder().encode(/walk-graph\/(\w+)\./.exec(url)![1]!)]);

function makeCtor(graphs: ReturnType<typeof makeGraph>[]): never {
  return function (bytes: Uint8Array) {
    const g = makeGraph(new TextDecoder().decode(bytes.subarray(4)));
    graphs.push(g);
    return g;
  } as never;
}

class FakeWalkWorker implements WalkGraphWorkerLike {
  static instances: FakeWalkWorker[] = [];
  onmessage: ((event: MessageEvent<WalkGraphReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly graphs: ReturnType<typeof makeGraph>[] = [];
  readonly fetch = vi.fn(async (url: string) => new Response(cityBody(url)));
  private readonly host = createWalkGraphHost({
    fetch: this.fetch as unknown as typeof fetch,
    artifacts: fixtureGraphArtifacts(this.fetch as unknown as typeof fetch),
    decompress: async () => PTWG,
    loadModule: async () => ({
      PtWalkGraph: makeCtor(this.graphs),
      default: async () => undefined,
    }),
  });

  constructor() {
    FakeWalkWorker.instances.push(this);
  }

  /** Requests held unanswered by `holdReplies()` until `release()`. */
  held: WalkGraphRequest[] | null = null;

  holdReplies(): void {
    this.held ??= [];
  }

  release(): void {
    const reqs = this.held ?? [];
    this.held = null;
    for (const req of reqs) this.answer(req);
  }

  postMessage(message: WalkGraphRequest): void {
    const req = structuredClone(message);
    if (this.held) {
      this.held.push(req);
      return;
    }
    setTimeout(() => this.answer(req), 0);
  }

  private answer(req: WalkGraphRequest): void {
    if (this.terminated) return;
    void this.host.handle(req).then((reply) => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<WalkGraphReply>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

describe("walkGraphClient over a worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWalkWorker.instances = [];
  });

  const A = { lat: 54.68, lon: 25.28 };
  const B = { lat: 54.681, lon: 25.281 };

  function workerClient(createWorker: () => FakeWalkWorker = () => new FakeWalkWorker()) {
    const clock = { t: 0 };
    const armed = new Map<number, () => void>();
    let nextTimer = 0;
    const timers = {
      set: (fn: () => void, _ms: number) => { armed.set(++nextTimer, fn); return nextTimer; },
      clear: (h: unknown) => { armed.delete(h as number); },
    };
    const fireIdle = () => {
      const fns = [...armed.values()];
      armed.clear();
      fns.forEach((fn) => fn());
    };
    const client = new WalkGraphClient({ createWorker, now: () => clock.t, timers });
    return { client, clock, armed, fireIdle };
  }

  it("keeps its exact worker during guidance even across a long idle transit leg", async () => {
    const {client, armed, fireIdle} = workerClient();
    client.setGuidanceActive(true);
    await client.ensureCity("vilnius");
    const worker = FakeWalkWorker.instances[0]!;
    expect(armed.size).toBe(0);
    fireIdle();
    expect(worker.terminated).toBe(false);
    expect(client.isReady("vilnius")).toBe(true);
    client.setGuidanceActive(false);
    expect(armed.size).toBe(1);
    fireIdle();
    expect(worker.terminated).toBe(true);
    expect(client.isReady("vilnius")).toBe(false);
  });

  it("restarts the worker after a rejected artifact, without reloading it", async () => {
    const { client } = workerClient(() => {
      const w = new FakeWalkWorker();
      // The artifact names another city: the load is rejected as bad.
      w.fetch.mockImplementation(async () => new Response(cityBody("/walk-graph/tricity.ptwg.br")));
      return w;
    });
    expect(await client.loadCity("vilnius")).toBe("bad");
    expect(FakeWalkWorker.instances[0]!.terminated).toBe(true);
    expect(await client.loadCity("vilnius")).toBe("bad");
    expect(await client.routeFor("vilnius", A, B, "default")).toBeNull();
    expect(FakeWalkWorker.instances).toHaveLength(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("restarts the worker after a routing error; the failing call still resolves", async () => {
    const { client } = workerClient();
    expect(await client.loadCity("vilnius")).toBe("ready");
    const first = FakeWalkWorker.instances[0]!;
    first.graphs[0]!.route.mockImplementationOnce(() => { throw new Error("unreachable"); });
    expect(await client.routeFor("vilnius", A, B, "default")).toBeNull();
    expect(first.terminated).toBe(true);
    expect(client.isReady("vilnius")).toBe(false);
    // The next call loads a fresh graph in a new worker, once.
    expect(await client.routeFor("vilnius", A, B, "default")).toEqual(ROUTE);
    expect(FakeWalkWorker.instances).toHaveLength(2);
    expect(FakeWalkWorker.instances[1]!.fetch).toHaveBeenCalledTimes(1);
  });

  it("after a crash the next routeFor reloads in a new worker", async () => {
    const { client } = workerClient();
    expect(await client.loadCity("vilnius")).toBe("ready");
    FakeWalkWorker.instances[0]!.crash("worker died");
    expect(client.isReady("vilnius")).toBe(false);
    expect(await client.routeFor("vilnius", A, B, "default")).toEqual(ROUTE);
    expect(FakeWalkWorker.instances).toHaveLength(2);
  });

  it("reports a routing failure once per city", async () => {
    const { client } = workerClient();
    await client.loadCity("vilnius");
    FakeWalkWorker.instances[0]!.graphs[0]!.route.mockImplementation(() => { throw new Error("boom"); });
    expect(await client.routeFor("vilnius", A, B, "default")).toBeNull();
    expect(await client.route("vilnius", A, B, "default")).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("switching city replaces the worker, so the old heap goes with it", async () => {
    const { client } = workerClient();
    expect(await client.loadCity("tricity")).toBe("ready");
    expect(await client.loadCity("vilnius")).toBe("ready");
    expect(FakeWalkWorker.instances).toHaveLength(2);
    expect(FakeWalkWorker.instances[0]!.terminated).toBe(true);
    expect(FakeWalkWorker.instances[1]!.graphs.map((g) => g.cityId())).toEqual(["vilnius"]);
    expect(client.isReady("vilnius")).toBe(true);
    expect(client.isReady("tricity")).toBe(false);
  });

  it("terminates an idle worker; the next call starts a new one", async () => {
    const { client, armed, fireIdle } = workerClient();
    const pending = client.loadCity("vilnius");
    expect(armed.size).toBe(0); // never idle while a request is pending
    expect(await pending).toBe("ready");
    expect(armed.size).toBe(1);
    fireIdle();
    expect(FakeWalkWorker.instances[0]!.terminated).toBe(true);
    expect(client.isReady("vilnius")).toBe(false);
    expect(await client.routeFor("vilnius", A, B, "default")).toEqual(ROUTE);
    expect(FakeWalkWorker.instances).toHaveLength(2);
    expect(armed.size).toBe(1);
  });

  it("starts the worker lazily, loads and routes through it", async () => {
    const { client } = workerClient();
    expect(FakeWalkWorker.instances).toHaveLength(0);
    expect(await client.routeFor("vilnius", A, B, "wheelchair")).toEqual(ROUTE);
    const [w] = FakeWalkWorker.instances;
    expect(FakeWalkWorker.instances).toHaveLength(1);
    expect(w!.fetch).toHaveBeenCalledWith("/walk-graph/vilnius.ptwg.br", expect.anything());
    expect(w!.graphs[0]!.route).toHaveBeenCalledWith(54.68, 25.28, 54.681, 25.281, "wheelchair");
    expect(client.isReady("vilnius")).toBe(true);
  });

  it("destroy terminates the worker; the next call starts a fresh one", async () => {
    const { client } = workerClient();
    await client.ensureCity("vilnius");
    client.destroy();
    expect(FakeWalkWorker.instances[0]!.terminated).toBe(true);
    expect(client.isReady("vilnius")).toBe(false);
    expect(await client.routeFor("vilnius", A, B, "default")).toEqual(ROUTE);
    expect(FakeWalkWorker.instances).toHaveLength(2);
  });

  it("a load cut off by destroy is superseded, not missing", async () => {
    const { client } = workerClient();
    const pending = client.loadCity("vilnius");
    client.destroy();
    expect(await pending).toBe("superseded");
    expect(await client.loadCity("vilnius")).toBe("ready");
  });

  it("a crashed worker fails its requests as transient and is replaced", async () => {
    const { client, clock } = workerClient();
    const pending = client.loadCity("vilnius");
    FakeWalkWorker.instances[0]!.crash("worker script failed to load");
    expect(await pending).toBe("transient");
    expect(FakeWalkWorker.instances[0]!.terminated).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    clock.t += 15_000;
    expect(await client.loadCity("vilnius")).toBe("ready");
    expect(FakeWalkWorker.instances).toHaveLength(2);
  });

  it("a city switch while a route is in flight supersedes it, unreported", async () => {
    const { client } = workerClient();
    expect(await client.loadCity("vilnius")).toBe("ready");
    const first = FakeWalkWorker.instances[0]!;
    first.holdReplies();
    const routing = client.routeFor("vilnius", A, B, "default");
    await vi.waitFor(() => expect(first.held).toHaveLength(1));
    const switching = client.loadCity("tricity");
    const err = await routing.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalkGraphUnavailableError);
    expect(err).toMatchObject({ cityId: "vilnius", reason: "superseded" });
    expect(first.terminated).toBe(true);
    expect(await switching).toBe("ready");
    expect(client.isReady("tricity")).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("never idles out a worker with a request pending", async () => {
    vi.useFakeTimers();
    try {
      // Default timers: the faked setTimeout.
      const client = new WalkGraphClient({ createWorker: () => new FakeWalkWorker() });
      const loading = client.loadCity("vilnius");
      await vi.advanceTimersByTimeAsync(0);
      expect(await loading).toBe("ready");
      const w = FakeWalkWorker.instances[0]!;

      w.holdReplies();
      const routing = client.routeFor("vilnius", A, B, "default");
      await vi.advanceTimersByTimeAsync(WALK_GRAPH_IDLE_MS + 1_000);
      expect(w.terminated).toBe(false);
      expect(client.isReady("vilnius")).toBe(true);

      w.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(await routing).toEqual(ROUTE);
      // The reply re-arms the idle timer from now.
      await vi.advanceTimersByTimeAsync(WALK_GRAPH_IDLE_MS - 1);
      expect(w.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.terminated).toBe(true);
      expect(client.isReady("vilnius")).toBe(false); // onDrop forgot the graph
      expect(FakeWalkWorker.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
