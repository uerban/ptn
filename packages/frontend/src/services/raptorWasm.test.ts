import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MobilityProfile, RaptorQuery, TransportMode } from "@pt/shared";
import { routeTypeToMode } from "@pt/shared/ptb";

const ptRouterCtorMock = vi.fn();
const ptRouterPlanMock = vi.fn();
const ptRouterSetTransfersMock = vi.fn();
const ptRouterFreeMock = vi.fn();
const ptRouterIsAliveMock = vi.fn(() => true);

class FakePtRouter {
  constructor(bytes: Uint8Array) { ptRouterCtorMock(bytes); }
  plan(q: unknown): unknown[] { return ptRouterPlanMock(q); }
  setTransfers(bytes: Uint8Array): void { ptRouterSetTransfersMock(bytes); }
  free(): void { ptRouterFreeMock(); }
  isAlive(): boolean { return ptRouterIsAliveMock(); }
}

// `default` is wasm-bindgen `--target web`'s manual init (`__wbg_init`).
// buildPtRouter calls `await mod.default()` to instantiate the wasm
// module before any other export touches it; the mock just resolves.
vi.mock("@pt/wasm", () => ({
  PtRouter: FakePtRouter,
  default: vi.fn().mockResolvedValue(undefined),
}));

import { engineMobilityProfile, type EngineMobilityProfile } from "@pt/shared/routing";
import {
  buildPtRouter, planWithWasm,
  PtWasmInitError, PtWasmQueryError, PtWasmTransfersError,
  transportModeToRouteTypes,
} from "./raptorWasm.ts";

beforeEach(() => {
  ptRouterCtorMock.mockClear();
  ptRouterPlanMock.mockClear();
  ptRouterSetTransfersMock.mockClear();
  ptRouterFreeMock.mockClear();
  ptRouterIsAliveMock.mockReturnValue(true);
});

describe("raptorWasm adapter", () => {
  it("buildPtRouter constructs from PTB bytes", async () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);
    const router = await buildPtRouter(bytes);
    expect(ptRouterCtorMock).toHaveBeenCalledWith(bytes);
    expect(router.isAlive()).toBe(true);
  });

  it("wraps ctor throw as PtWasmInitError", async () => {
    ptRouterCtorMock.mockImplementationOnce(() => { throw new Error("bad bytes"); });
    await expect(buildPtRouter(new Uint8Array(0))).rejects.toBeInstanceOf(PtWasmInitError);
  });

  it("planWithWasm coerces each TransportMode to its single base route_type", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterPlanMock.mockReturnValueOnce([]);
    const query = {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S2", walkSecs: 0 }],
      activeServiceIds: new Set(["svc:0"]),
      departureSecs: 0,
      excludedModes: ["BUS", "TRAM"],
    } as unknown as RaptorQuery;
    await planWithWasm(router, query, "20260523");
    const passed = ptRouterPlanMock.mock.calls[0]![0] as { excludedModes: number[] };
    expect(passed.excludedModes).toEqual([3, 0]); // BUS→[3], TRAM→[0]
  });

  it("every base route_type round-trips back to its mode", () => {
    const ROUTE_MODES = ["TRAM","METRO","RAIL","BUS","FERRY","CABLE_TRAM","AERIAL","FUNICULAR","TROLLEYBUS","OTHER"] as const;
    for (const m of ROUTE_MODES) {
      for (const rt of transportModeToRouteTypes(m)) {
        expect(routeTypeToMode(rt)).toBe(m);
      }
    }
  });

  it("leg / legacy / unknown modes coerce to no exclusion (tolerant, no throw)", () => {
    expect(transportModeToRouteTypes("WALK")).toEqual([]); // leg mode (valid union member)
    expect(transportModeToRouteTypes("CABLE_CAR" as TransportMode)).toEqual([]); // CABLE_CAR is no longer a union member; the cast exercises the tolerant default ([]) arm
    expect(transportModeToRouteTypes("FOO" as TransportMode)).toEqual([]); // genuinely unknown
  });

  it("forwards route IDs before planning and leaves the empty case absent", async () => {
    const router = await buildPtRouter(new Uint8Array([1, 2, 3]));
    const query: RaptorQuery = { entryStops: [], exitStops: [], departureSecs: 0, activeServiceIds: new Set<string>(),
      excludedRouteIds: ["operator:minibus-472", "operator:minibus-532"] };
    await planWithWasm(router, query, "20260523");
    expect(ptRouterPlanMock.mock.calls.at(-1)?.[0]).toMatchObject({ excludedRouteIds: query.excludedRouteIds });
    await planWithWasm(router, { ...query, excludedRouteIds: [] }, "20260523");
    expect(ptRouterPlanMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("excludedRouteIds");
  });

  it("empty excludedModes array becomes undefined on wasm side (no-filter contract)", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterPlanMock.mockReturnValueOnce([]);
    const query = {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S2", walkSecs: 0 }],
      activeServiceIds: new Set(),
      departureSecs: 0,
      excludedModes: [],
    } as unknown as RaptorQuery;
    await planWithWasm(router, query, "20260523");
    const passed = ptRouterPlanMock.mock.calls[0]![0] as { excludedModes?: number[] };
    expect(passed.excludedModes).toBeUndefined();
  });

  it("planWithWasm passes `date` through (no service-day expansion)", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterPlanMock.mockReturnValueOnce([]);
    await planWithWasm(router, {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S2", walkSecs: 0 }],
      activeServiceIds: new Set(), departureSecs: 0,
    } as unknown as RaptorQuery, "20260523");
    const passed = ptRouterPlanMock.mock.calls[0]![0] as { date: string };
    expect(passed.date).toBe("20260523");
    expect("activeServiceIds" in passed).toBe(false);
  });

  // Every rider profile must reach the engine as one it accepts
  // (`classify_mobility`, crates/pt-wasm/src/query.rs): a profile the engine
  // rejects fails every plan. A `Record` so a new profile breaks this table.
  const ENGINE_PROFILE: Record<MobilityProfile, EngineMobilityProfile> = {
    default: "default",
    wheelchair: "wheelchair",
    bicycle: "bicycle",
    vision_impaired: "default",
  };
  it.each(Object.entries(ENGINE_PROFILE))("planWithWasm sends the %s profile as %s", async (profile, expected) => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterPlanMock.mockReturnValueOnce([]);
    await planWithWasm(router, {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S2", walkSecs: 0 }],
      activeServiceIds: new Set(), departureSecs: 0,
      mobilityProfile: profile as MobilityProfile,
    } as unknown as RaptorQuery, "20260523");
    const passed = ptRouterPlanMock.mock.calls[0]![0] as { mobilityProfile?: string };
    expect(passed.mobilityProfile).toBe(expected);
  });

  it("planWithWasm leaves an absent profile absent (the engine default)", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterPlanMock.mockReturnValueOnce([]);
    await planWithWasm(router, {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S2", walkSecs: 0 }],
      activeServiceIds: new Set(), departureSecs: 0,
    } as unknown as RaptorQuery, "20260523");
    const passed = ptRouterPlanMock.mock.calls[0]![0] as { mobilityProfile?: string };
    expect(passed.mobilityProfile).toBeUndefined();
    expect(engineMobilityProfile(undefined)).toBeUndefined();
  });

  it("planWithWasm forwards the walking speed and minimum transfer, and omits them when absent", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    const base = {
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S2", walkSecs: 0 }],
      activeServiceIds: new Set(), departureSecs: 0,
    };
    ptRouterPlanMock.mockReturnValueOnce([]).mockReturnValueOnce([]);
    await planWithWasm(router, { ...base, walkSpeedMps: 0.9, minTransferSecs: 180 } as unknown as RaptorQuery, "20260523");
    await planWithWasm(router, base as unknown as RaptorQuery, "20260523");
    const [withParams, without] = ptRouterPlanMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(withParams).toMatchObject({ walkSpeedMps: 0.9, minTransferSecs: 180 });
    expect("walkSpeedMps" in without!).toBe(false);
    expect("minTransferSecs" in without!).toBe(false);
  });

  it("wraps router.plan throws as PtWasmQueryError", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterPlanMock.mockImplementationOnce(() => { throw new Error("query exploded"); });
    await expect(planWithWasm(router, {
      entryStops: [], exitStops: [], activeServiceIds: new Set(), departureSecs: 0,
    } as unknown as RaptorQuery, "20260523")).rejects.toBeInstanceOf(PtWasmQueryError);
  });

  it("free() is centrally idempotent — wrapper collapses repeat calls to one raw free (panel qa HIGH)", async () => {
    // The adapter's TS wrapper guarantees idempotency regardless of what
    // the wasm side does — repeated TS-side free() calls collapse to one
    // raw.free() call. Catches a future regression in wasm-bindgen's
    // generated free() (which on its own throws "null pointer passed to
    // rust" on a second call).
    const router = await buildPtRouter(new Uint8Array([1]));
    router.free();
    expect(() => router.free()).not.toThrow();
    expect(() => router.free()).not.toThrow();
    expect(ptRouterFreeMock).toHaveBeenCalledTimes(1);
    expect(router.isAlive()).toBe(false);
  });

  it("setTransfers forwards bytes unmodified to the raw handle", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    const transfers = new Uint8Array([0x50, 0x54, 0x46, 0x54, 0x01, 0x00]);
    await router.setTransfers(transfers);
    expect(ptRouterSetTransfersMock).toHaveBeenCalledTimes(1);
    // Reference equality — the in-process adapter MUST NOT copy/slice/clone
    // the buffer (a silent realloc would defeat IDB-blob-direct reuse and
    // waste a multi-MB allocation on every transfers swap). The worker path
    // has to hand the worker its own copy; that is its one copy.
    expect(ptRouterSetTransfersMock.mock.calls[0]![0]).toBe(transfers);
  });

  it("setTransfers propagates raw throw verbatim (decode errors surface to caller)", async () => {
    const router = await buildPtRouter(new Uint8Array([1]));
    ptRouterSetTransfersMock.mockImplementationOnce(() => {
      throw new Error("transfers decode: BadMagic");
    });
    await expect(router.setTransfers(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /transfers decode: BadMagic/,
    );
  });

  it("setTransfers after free() throws PtWasmTransfersError without touching the raw handle", async () => {
    // Mirrors the post-free plan() contract — once the wrapper has flipped
    // `alive=false`, neither plan() nor setTransfers() may reach into the
    // freed handle. A typed throw keeps callers' error branches symmetric.
    const router = await buildPtRouter(new Uint8Array([1]));
    router.free();
    ptRouterSetTransfersMock.mockClear();
    await expect(router.setTransfers(new Uint8Array([1]))).rejects.toThrow(PtWasmTransfersError);
    expect(ptRouterSetTransfersMock).not.toHaveBeenCalled();
  });

  it("plan() after free() throws PtWasmQueryError without touching the raw handle (panel qa HIGH)", async () => {
    // The wrapper's `alive` flag short-circuits raw.plan, so the test
    // doesn't need to coerce the underlying isAlive mock — proves the
    // adapter is the correctness backstop, not the wasm contract.
    const router = await buildPtRouter(new Uint8Array([1]));
    router.free();
    ptRouterPlanMock.mockClear();
    await expect(planWithWasm(router, {
      entryStops: [], exitStops: [], activeServiceIds: new Set(), departureSecs: 0,
    } as unknown as RaptorQuery, "20260523")).rejects.toBeInstanceOf(PtWasmQueryError);
    expect(ptRouterPlanMock).not.toHaveBeenCalled();
  });
});

describe("raptorWasm adapter — import failure path (separate describe so vi.mock can be overridden)", () => {
  it("wraps dynamic-import rejection as PtWasmImportError", async () => {
    vi.resetModules();
    vi.doMock("@pt/wasm", () => { throw new TypeError("network 404"); });
    const fresh = await import("./raptorWasm.ts");
    await expect(fresh.buildPtRouter(new Uint8Array([1]))).rejects.toBeInstanceOf(fresh.PtWasmImportError);
    vi.doUnmock("@pt/wasm");
  });
});
