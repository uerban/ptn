import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PtRouterHandle } from "../services/raptorWasm.ts";

// `initGeneration` is a MODULE-LEVEL `let` in gtfsDataStore.ts (not store
// state), so a plain `reset()` between tests isn't enough to get a clean
// generation counter. We re-import the store module fresh in each test via
// `vi.resetModules()` + a dynamic import, which re-evaluates the module and
// resets `initGeneration` back to 0. The `vi.doMock(...)` registrations are
// re-applied in the same `beforeEach` (doMock is not hoisted, and the
// registry is cleared by resetModules) so the fresh module graph picks up the
// stubs. The mock fns themselves live at module scope so they survive
// `resetModules` and can be configured per-test.
const syncGtfsDataMock = vi.fn();
const needsSyncMock = vi.fn();
const clearGtfsDataMock = vi.fn();
const buildRaptorIndexMock = vi.fn();
const osrmInitMock = vi.fn();
const ensureDbReadyMock = vi.fn();
const stopsToArrayMock = vi.fn();
const initOrSwapPtRouterMock = vi.fn();

type GtfsDataStore = (typeof import("./gtfsDataStore.ts"))["useGtfsDataStore"];
let useGtfsDataStore: GtfsDataStore;

function makeRouter(): PtRouterHandle {
  return { plan: () => [], free: vi.fn(), isAlive: () => true } as unknown as PtRouterHandle;
}

beforeEach(async () => {
  vi.resetModules();

  syncGtfsDataMock.mockReset().mockResolvedValue(true);
  needsSyncMock.mockReset().mockResolvedValue(false);
  clearGtfsDataMock.mockReset().mockResolvedValue(undefined);
  buildRaptorIndexMock.mockReset().mockResolvedValue({ cityTzIana: "Europe/Vilnius" });
  osrmInitMock.mockReset().mockResolvedValue(undefined);
  ensureDbReadyMock.mockReset().mockResolvedValue({ recovered: false });
  stopsToArrayMock.mockReset().mockResolvedValue([]);
  initOrSwapPtRouterMock.mockReset();

  vi.doMock("../services/gtfsSync.ts", () => ({
    syncGtfsData: syncGtfsDataMock,
    needsSync: needsSyncMock,
    clearGtfsData: clearGtfsDataMock,
  }));
  vi.doMock("../services/raptorIndex.ts", () => ({
    buildRaptorIndex: buildRaptorIndexMock,
  }));
  vi.doMock("../services/osrmWasm.ts", () => ({
    osrmClient: { init: osrmInitMock },
  }));
  vi.doMock("../services/wasmLifecycle.ts", () => ({
    initOrSwapPtRouter: initOrSwapPtRouterMock,
  }));
  vi.doMock("../db/migrationRunner.ts", () => ({
    ensureDbReady: ensureDbReadyMock,
  }));
  vi.doMock("../db/index.ts", () => ({
    db: { gtfsStops: { toArray: stopsToArrayMock } },
  }));

  ({ useGtfsDataStore } = await import("./gtfsDataStore.ts"));
});

describe("gtfsDataStore wasm engine lifecycle", () => {
  it("starts idle", () => {
    const we = useGtfsDataStore.getState().wasmEngine;
    expect(we.status).toBe("idle");
    expect(we.cityId).toBeNull();
    expect(we.initGeneration).toBeNull();
    expect(we.error).toBeNull();
    expect(we.initPromise).toBeNull();
  });

  it("transitions to loading while initOrSwapPtRouter is in flight", () => {
    // Never resolves — we only assert the synchronous loading transition.
    initOrSwapPtRouterMock.mockReturnValueOnce(new Promise(() => {}));

    const p = useGtfsDataStore.getState().ensureWasmReady("vilnius");
    p.catch(() => {}); // silence the dangling-promise unhandled-rejection guard

    const we = useGtfsDataStore.getState().wasmEngine;
    expect(we.status).toBe("loading");
    expect(we.cityId).toBe("vilnius");
    expect(we.initGeneration).toBe(0);
    expect(we.initPromise).toBe(p);
  });

  it("transitions to ready when init resolves with an installed router", async () => {
    // init()/refresh() set loadedCityId; the ready guard requires it to match.
    useGtfsDataStore.setState({ loadedCityId: "vilnius" });
    const router = makeRouter();
    // The real initOrSwapPtRouter installs the handle on the store; mirror it.
    initOrSwapPtRouterMock.mockImplementationOnce(async () => {
      useGtfsDataStore.getState().setPtRouter(router);
      return router;
    });

    const result = await useGtfsDataStore.getState().ensureWasmReady("vilnius");

    expect(result).toBe(router);
    const we = useGtfsDataStore.getState().wasmEngine;
    expect(we.status).toBe("ready");
    expect(we.cityId).toBe("vilnius");
    expect(we.error).toBeNull();
    expect(we.initPromise).toBeNull();
  });

  it("transitions to failed (carrying the error message) when init rejects", async () => {
    initOrSwapPtRouterMock.mockRejectedValueOnce(new Error("bad bytes"));

    await expect(useGtfsDataStore.getState().ensureWasmReady("vilnius")).rejects.toThrow("bad bytes");

    const we = useGtfsDataStore.getState().wasmEngine;
    expect(we.status).toBe("failed");
    expect(we.error).toContain("bad bytes");
  });

  it("times out a hung init and marks it failed so later searches don't re-wait", async () => {
    vi.useFakeTimers();
    try {
      // initOrSwapPtRouter never settles (e.g. a stalled fetch with no timeout).
      initOrSwapPtRouterMock.mockReturnValueOnce(new Promise<PtRouterHandle>(() => {}));
      const p = useGtfsDataStore.getState().ensureWasmReady("vilnius");
      // Attach the rejection handler BEFORE advancing so `p` isn't briefly unhandled.
      const assertion = expect(p).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
      // The lifecycle is now `failed` — a second call at the same generation
      // rejects IMMEDIATELY (no rebuild, no second 8s wait).
      expect(useGtfsDataStore.getState().wasmEngine.status).toBe("failed");
      await expect(useGtfsDataStore.getState().ensureWasmReady("vilnius")).rejects.toThrow(/timed out/i);
      expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark ready when init resolves after reset", async () => {
    const router = makeRouter();
    let resolveInit!: (router: PtRouterHandle) => void;
    initOrSwapPtRouterMock.mockReturnValueOnce(new Promise((resolve) => { resolveInit = resolve; }));

    const init = useGtfsDataStore.getState().ensureWasmReady("vilnius");
    await useGtfsDataStore.getState().reset();
    resolveInit(router);
    await expect(init).rejects.toThrow(/stale wasm init/i);

    expect(useGtfsDataStore.getState().wasmEngine.status).toBe("idle");
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });

  it("surfaces a stale error (not the raw failure) when init REJECTS after reset", async () => {
    // A build that REJECTS — not resolves — after a generation bump is
    // staleness, not a failure: it must throw the stale sentinel (so
    // the planning boundary DROPS the obsolete search instead of surfacing an
    // engine error for the old query) and leave the lifecycle idle, never
    // `failed`.
    let rejectInit!: (err: Error) => void;
    initOrSwapPtRouterMock.mockReturnValueOnce(new Promise((_, reject) => { rejectInit = reject; }));

    const init = useGtfsDataStore.getState().ensureWasmReady("vilnius");
    await useGtfsDataStore.getState().reset();
    rejectInit(new Error("network down"));

    await expect(init).rejects.toThrow(/stale wasm init/i);
    // The raw build error is NOT surfaced, and the lifecycle is idle, not failed.
    const we = useGtfsDataStore.getState().wasmEngine;
    expect(we.status).toBe("idle");
    expect(we.error).toBeNull();
  });

  it("does not mark ready for a city the user switched away from", async () => {
    // The city switch fires its own eager init; hand that one a router the
    // store will drop (it is never installed), so only the generation bump
    // matters for the assertion below.
    initOrSwapPtRouterMock.mockImplementation(() => Promise.resolve(makeRouter()));
    useGtfsDataStore.setState({ loadedCityId: "vilnius" });

    const staleRouter = makeRouter();
    let resolveInit!: () => void;
    initOrSwapPtRouterMock.mockImplementationOnce(
      () => new Promise<PtRouterHandle>((resolve) => { resolveInit = () => resolve(staleRouter); }),
    );

    const vilniusInit = useGtfsDataStore.getState().ensureWasmReady("vilnius");
    // A real city switch through init(): bumps initGeneration and moves
    // loadedCityId to kaunas, exactly like a user picking a new city.
    await useGtfsDataStore.getState().init("kaunas");
    expect(useGtfsDataStore.getState().loadedCityId).toBe("kaunas");

    resolveInit();
    await expect(vilniusInit).rejects.toThrow(/stale wasm init/i);
    expect(useGtfsDataStore.getState().wasmEngine.status).not.toBe("ready");
  });

  it("dedupes concurrent callers onto a single init", async () => {
    useGtfsDataStore.setState({ loadedCityId: "vilnius" });
    const router = makeRouter();
    let resolveInit!: () => void;
    initOrSwapPtRouterMock.mockImplementationOnce(
      () => new Promise<PtRouterHandle>((resolve) => {
        resolveInit = () => {
          useGtfsDataStore.getState().setPtRouter(router);
          resolve(router);
        };
      }),
    );

    const p1 = useGtfsDataStore.getState().ensureWasmReady("vilnius");
    const p2 = useGtfsDataStore.getState().ensureWasmReady("vilnius");

    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    resolveInit();
    await expect(p1).resolves.toBe(router);
    await expect(p2).resolves.toBe(router);
    expect(useGtfsDataStore.getState().wasmEngine.status).toBe("ready");
  });

  it("does not retry a failed init at the same generation, but retries after a generation change", async () => {
    initOrSwapPtRouterMock.mockRejectedValueOnce(new Error("boom"));
    await expect(useGtfsDataStore.getState().ensureWasmReady("vilnius")).rejects.toThrow("boom");
    expect(useGtfsDataStore.getState().wasmEngine.status).toBe("failed");
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);

    // Same city, same generation → no second build attempt.
    await expect(useGtfsDataStore.getState().ensureWasmReady("vilnius")).rejects.toThrow(/boom/);
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);

    // A generation change (reset) clears the no-retry latch.
    await useGtfsDataStore.getState().reset();
    initOrSwapPtRouterMock.mockReturnValueOnce(new Promise(() => {}));
    const retry = useGtfsDataStore.getState().ensureWasmReady("vilnius");
    retry.catch(() => {});
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(2);
    expect(useGtfsDataStore.getState().wasmEngine.status).toBe("loading");
  });
});

describe("gtfsDataStore warm start builds the engine alongside the JS index", () => {
  it("starts the engine build before the JS index is built, and builds once", async () => {
    let finishIndex!: () => void;
    buildRaptorIndexMock.mockReturnValueOnce(
      new Promise((resolve) => { finishIndex = () => resolve({ cityTzIana: "Europe/Vilnius" }); }),
    );
    initOrSwapPtRouterMock.mockReturnValue(new Promise(() => {}));

    const init = useGtfsDataStore.getState().init("vilnius");
    await vi.waitFor(() => expect(buildRaptorIndexMock).toHaveBeenCalledTimes(1));
    // The build started while the index is still being built.
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
    expect(useGtfsDataStore.getState().raptorIndex).toBeNull();
    expect(useGtfsDataStore.getState().wasmEngine.status).toBe("loading");

    finishIndex();
    await init;
    // The eager init after the index joins the same build.
    expect(useGtfsDataStore.getState().loadedCityId).toBe("vilnius");
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
    expect(osrmInitMock).toHaveBeenCalledTimes(1);
  });

  it("an engine finished before the index is ready, not stale", async () => {
    let finishIndex!: () => void;
    buildRaptorIndexMock.mockReturnValueOnce(
      new Promise((resolve) => { finishIndex = () => resolve({ cityTzIana: "Europe/Vilnius" }); }),
    );
    const router = makeRouter();
    initOrSwapPtRouterMock.mockImplementationOnce(async () => {
      useGtfsDataStore.getState().setPtRouter(router);
      return router;
    });

    const init = useGtfsDataStore.getState().init("vilnius");
    await vi.waitFor(() => expect(useGtfsDataStore.getState().wasmEngine.status).toBe("ready"));
    expect(useGtfsDataStore.getState().loadedCityId).toBeNull();

    finishIndex();
    await init;
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
    await expect(useGtfsDataStore.getState().ensureWasmReady("vilnius")).resolves.toBe(router);
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
  });

  it("a fresh sync still builds the engine only after the index", async () => {
    needsSyncMock.mockResolvedValueOnce(true);
    let finishIndex!: () => void;
    buildRaptorIndexMock.mockReturnValueOnce(
      new Promise((resolve) => { finishIndex = () => resolve({ cityTzIana: "Europe/Vilnius" }); }),
    );
    initOrSwapPtRouterMock.mockReturnValue(new Promise(() => {}));

    const init = useGtfsDataStore.getState().init("vilnius");
    await vi.waitFor(() => expect(buildRaptorIndexMock).toHaveBeenCalledTimes(1));
    expect(initOrSwapPtRouterMock).not.toHaveBeenCalled();

    finishIndex();
    await init;
    expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1);
  });

  it("a reset during the early build leaves the engine idle, never ready", async () => {
    let finishIndex!: () => void;
    buildRaptorIndexMock.mockReturnValueOnce(
      new Promise((resolve) => { finishIndex = () => resolve({ cityTzIana: "Europe/Vilnius" }); }),
    );
    let finishBuild!: () => void;
    const router = makeRouter();
    initOrSwapPtRouterMock.mockReturnValueOnce(new Promise((resolve) => { finishBuild = () => resolve(router); }));

    const init = useGtfsDataStore.getState().init("vilnius");
    await vi.waitFor(() => expect(initOrSwapPtRouterMock).toHaveBeenCalledTimes(1));
    await useGtfsDataStore.getState().reset();
    finishBuild();
    finishIndex();
    await init;
    await vi.waitFor(() => expect(useGtfsDataStore.getState().wasmEngine.status).toBe("idle"));
    expect(useGtfsDataStore.getState().raptorIndex).toBeNull();
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });
});
