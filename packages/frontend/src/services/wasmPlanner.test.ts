import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RaptorItinerary, RaptorQuery } from "@pt/shared";
import type { PtRouterHandle } from "./raptorWasm.ts";

// `vi.mock` is hoisted to the top of the file; reference its mock via
// `vi.hoisted` so the binding exists when the factory runs. Only
// `planWithWasm` is faked — the error classes stay REAL so the
// `instanceof` branches under test are the production ones.
const { planWithWasmMock } = vi.hoisted(() => ({
  planWithWasmMock: vi.fn(async (
    _router: PtRouterHandle,
    _query: RaptorQuery,
    _date: string,
  ): Promise<RaptorItinerary[]> => []),
}));

vi.mock("./raptorWasm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./raptorWasm.ts")>()),
  planWithWasm: planWithWasmMock,
}));

import {
  PtEngineMisconfiguredError,
  PtWasmQueryError,
  PtWasmImportError,
  PtWasmTransfersError,
  StaleWasmInitError,
} from "./raptorWasm.ts";
import { planOnDevice, resolveDepartureOnDevice, type WasmPlanContext } from "./wasmPlanner.ts";
import { PtWasmTimeError } from "./raptorWasm.ts";

const QUERY = {} as RaptorQuery;

function router(): PtRouterHandle {
  return {
    plan: async () => [],
    resolveTime: async () => ({ serviceDate: "20260523", timeOriginUnix: 0, departureSecs: 0 }),
    setTransfers: async () => {},
    free: () => {},
    isAlive: () => true,
  };
}

function context(overrides: Partial<WasmPlanContext> = {}): WasmPlanContext {
  return {
    ptRouter: null,
    cityId: "vilnius",
    ...overrides,
  };
}

describe("planOnDevice", () => {
  beforeEach(() => {
    planWithWasmMock.mockClear();
    planWithWasmMock.mockResolvedValue([]);
  });

  it("a ready live router plans without awaiting a rebuild", async () => {
    const ptRouter = router();
    const itineraries = [{ legs: [] }] as unknown as RaptorItinerary[];
    planWithWasmMock.mockResolvedValueOnce(itineraries);

    const result = await planOnDevice(QUERY, context({ ptRouter }), "20260523");

    expect(planWithWasmMock).toHaveBeenCalledTimes(1);
    expect(planWithWasmMock.mock.calls[0][0]).toBe(ptRouter);
    expect(planWithWasmMock.mock.calls[0][2]).toBe("20260523");
    expect(result).toBe(itineraries);
  });

  it("builds/awaits the router for the SEARCH city at the current generation", async () => {
    const ptRouter = router();
    const ensureWasmReady = vi.fn(async () => ptRouter);

    await planOnDevice(
      QUERY,
      context({
        wasmEngine: { status: "idle", cityId: null, initGeneration: null, error: null, initPromise: null },
        ensureWasmReady,
        getInitGeneration: () => 3,
      }),
      "20260523",
    );

    expect(ensureWasmReady).toHaveBeenCalledWith("vilnius");
    expect(planWithWasmMock).toHaveBeenCalledTimes(1);
  });

  it("re-resolves via ensureWasmReady even when ctx.ptRouter holds a stale cross-city handle", async () => {
    // init() installs the new index/loadedCityId BEFORE the new router is
    // built, so ctx.ptRouter can still be the PREVIOUS city's handle. The plan
    // must run against the freshly-resolved router, never the stale one.
    const staleRouter = router();
    const freshRouter = router();
    const ensureWasmReady = vi.fn(async () => freshRouter);

    await planOnDevice(
      QUERY,
      context({
        ptRouter: staleRouter,
        cityId: "kaunas",
        wasmEngine: { status: "ready", cityId: "vilnius", initGeneration: 1, error: null, initPromise: null },
        ensureWasmReady,
      }),
      "20260523",
    );

    expect(ensureWasmReady).toHaveBeenCalledWith("kaunas");
    expect(planWithWasmMock.mock.calls[0][0]).toBe(freshRouter);
  });

  it("a missing router with no way to build one is a typed engine failure (no itineraries)", async () => {
    await expect(planOnDevice(QUERY, context(), "20260523"))
      .rejects.toBeInstanceOf(PtEngineMisconfiguredError);
    expect(planWithWasmMock).not.toHaveBeenCalled();
  });

  it("an empty cityId fails as a setup error instead of fetching /api//raptor-bundle", async () => {
    const ensureWasmReady = vi.fn(async () => router());

    await expect(
      planOnDevice(
        QUERY,
        context({
          cityId: "",
          wasmEngine: { status: "idle", cityId: null, initGeneration: null, error: null, initPromise: null },
          ensureWasmReady,
        }),
        "20260523",
      ),
    ).rejects.toBeInstanceOf(PtEngineMisconfiguredError);
    expect(ensureWasmReady).not.toHaveBeenCalled();
    expect(planWithWasmMock).not.toHaveBeenCalled();
  });

  it("a terminal init failure at this city/generation surfaces without re-awaiting the build", async () => {
    const ensureWasmReady = vi.fn(async () => router());

    await expect(
      planOnDevice(
        QUERY,
        context({
          wasmEngine: { status: "failed", cityId: "vilnius", initGeneration: 1, error: "bad bytes", initPromise: null },
          ensureWasmReady,
          getInitGeneration: () => 1,
        }),
        "20260523",
      ),
    ).rejects.toThrow(/bad bytes/);
    expect(ensureWasmReady).not.toHaveBeenCalled();
    expect(planWithWasmMock).not.toHaveBeenCalled();
  });

  it("a failed wasm state from a PRIOR generation does not block a rebuild", async () => {
    const ptRouter = router();
    const ensureWasmReady = vi.fn(async () => ptRouter);

    await planOnDevice(
      QUERY,
      context({
        // failed at gen 1, but the live generation is now 2 (a same-city
        // refresh/re-init) — the old failure must NOT short-circuit the rebuild.
        wasmEngine: { status: "failed", cityId: "vilnius", initGeneration: 1, error: "bad bytes", initPromise: null },
        ensureWasmReady,
        getInitGeneration: () => 2,
      }),
      "20260523",
    );

    expect(ensureWasmReady).toHaveBeenCalledWith("vilnius");
    expect(planWithWasmMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["import", new PtWasmImportError(new Error("chunk 404")), PtWasmImportError],
    ["transfers", new PtWasmTransfersError(new Error("bad PTFT")), PtWasmTransfersError],
  ])("a %s error from the build propagates with its own type", async (_label, thrown, ctor) => {
    const ensureWasmReady = vi.fn(async (): Promise<PtRouterHandle> => { throw thrown; });

    await expect(
      planOnDevice(QUERY, context({ ensureWasmReady }), "20260523"),
    ).rejects.toBeInstanceOf(ctor);
    expect(planWithWasmMock).not.toHaveBeenCalled();
  });

  it("a query error propagates as PtWasmQueryError and yields no itineraries", async () => {
    planWithWasmMock.mockRejectedValueOnce(new PtWasmQueryError(new Error("plan panicked")));

    await expect(
      planOnDevice(QUERY, context({ ptRouter: router() }), "20260523"),
    ).rejects.toBeInstanceOf(PtWasmQueryError);
  });

  it("a stale wasm init result is re-thrown so the caller drops the obsolete search", async () => {
    const ensureWasmReady = vi.fn(async () => { throw new StaleWasmInitError(); });

    await expect(
      planOnDevice(
        QUERY,
        context({
          wasmEngine: { status: "loading", cityId: "vilnius", initGeneration: 1, error: null, initPromise: new Promise(() => {}) },
          ensureWasmReady,
        }),
        "20260523",
      ),
    ).rejects.toBeInstanceOf(StaleWasmInitError);
    expect(planWithWasmMock).not.toHaveBeenCalled();
  });

  it("bounds the init wait and surfaces the timeout as a typed engine failure", async () => {
    vi.useFakeTimers();
    try {
      const ensureWasmReady = vi.fn(() => new Promise<never>(() => { /* never resolves */ }));
      const p = planOnDevice(
        QUERY,
        context({
          wasmEngine: { status: "loading", cityId: "vilnius", initGeneration: 1, error: null, initPromise: new Promise(() => {}) },
          ensureWasmReady,
        }),
        "20260523",
      );
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
      expect(planWithWasmMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timeout AFTER a generation bump is treated as stale, not as an engine failure", async () => {
    vi.useFakeTimers();
    try {
      const ensureWasmReady = vi.fn(() => new Promise<never>(() => { /* hangs past the timeout */ }));
      // Generation moves 1 → 2 while the build hangs (a city switch). The
      // timeout fires before the stale build settles; the search must be
      // DROPPED rather than reported as a wasm failure for the old query.
      let gen = 1;
      const p = planOnDevice(
        QUERY,
        context({
          wasmEngine: { status: "loading", cityId: "vilnius", initGeneration: 1, error: null, initPromise: new Promise(() => {}) },
          ensureWasmReady,
          getInitGeneration: () => gen,
        }),
        "20260523",
      );
      gen = 2; // city switch lands while the build hangs
      // Attach the rejection handler BEFORE advancing timers so `p` rejecting
      // mid-advance isn't briefly unhandled.
      const assertion = expect(p).rejects.toBeInstanceOf(StaleWasmInitError);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
      expect(planWithWasmMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveDepartureOnDevice", () => {
  it("resolves the instant through the bundle's own service-day origins", async () => {
    const resolveTime = vi.fn(async () => ({ serviceDate: "20260329", timeOriginUnix: 1774731600, departureSecs: 5400 }));
    const ptRouter = { ...router(), resolveTime };
    const result = await resolveDepartureOnDevice(1774743000, context({ ptRouter }));
    expect(resolveTime).toHaveBeenCalledWith(1774743000);
    expect(result).toEqual({ serviceDate: "20260329", timeOriginUnix: 1774731600, departureSecs: 5400 });
  });

  it("keeps the router's typed time error intact (a v1 bundle's refusal is not a setup failure)", async () => {
    // The typed wrapper in raptorWasm turns the wasm throw into PtWasmTimeError;
    // the boundary must pass that through rather than re-wrap it as a setup error.
    const ptRouter = {
      ...router(),
      resolveTime: async () => { throw new PtWasmTimeError(new Error("pt-core time resolution: UnsupportedVersion")); },
    };
    const err = await resolveDepartureOnDevice(1774743000, context({ ptRouter })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PtWasmTimeError);
  });
});

