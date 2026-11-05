import { describe, it, expect, vi, beforeEach } from "vitest";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import type { PtRouterHandle } from "../../src/services/raptorWasm.ts";

function fakeRouter(id: string): PtRouterHandle & { __id: string; __freed: boolean } {
  const r = {
    __id: id, __freed: false,
    plan: vi.fn(() => []),
    setTransfers: vi.fn(),
    free: vi.fn(function (this: { __freed: boolean }) { this.__freed = true; }),
    isAlive: vi.fn(function (this: { __freed: boolean }) { return !this.__freed; }),
  };
  return r as unknown as PtRouterHandle & { __id: string; __freed: boolean };
}

describe("useGtfsDataStore — PtRouter lifecycle", () => {
  beforeEach(async () => { await useGtfsDataStore.getState().reset(); });

  it("reset() frees the handle BEFORE nulling", async () => {
    const r1 = fakeRouter("a");
    useGtfsDataStore.getState().setPtRouter(r1 as PtRouterHandle);
    await useGtfsDataStore.getState().reset();
    expect(r1.__freed).toBe(true);
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });

  it("swapPtRouter sets new handle then defers free() to next macrotask (panel engineer #2)", async () => {
    const r1 = fakeRouter("a");
    const r2 = fakeRouter("b");
    useGtfsDataStore.getState().setPtRouter(r1 as PtRouterHandle);
    useGtfsDataStore.getState().swapPtRouter(r2 as PtRouterHandle);
    // Immediately after swap: new handle is live, old NOT YET freed.
    expect(useGtfsDataStore.getState().ptRouter).toBe(r2);
    expect(r1.__freed).toBe(false);
    // After macrotask: old is freed.
    await new Promise((r) => setTimeout(r, 0));
    expect(r1.__freed).toBe(true);
    expect(r2.__freed).toBe(false);
  });

  it("setPtRouter(null) explicitly frees the prior handle", () => {
    const r1 = fakeRouter("a");
    useGtfsDataStore.getState().setPtRouter(r1 as PtRouterHandle);
    useGtfsDataStore.getState().setPtRouter(null);
    expect(r1.__freed).toBe(true);
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });

  it("two rapid swaps free the intermediate handle (no leak)", async () => {
    const r1 = fakeRouter("a");
    const r2 = fakeRouter("b");
    const r3 = fakeRouter("c");
    useGtfsDataStore.getState().setPtRouter(r1 as PtRouterHandle);
    useGtfsDataStore.getState().swapPtRouter(r2 as PtRouterHandle);
    useGtfsDataStore.getState().swapPtRouter(r3 as PtRouterHandle);
    await new Promise((r) => setTimeout(r, 0));
    expect(r1.__freed).toBe(true);
    expect(r2.__freed).toBe(true);
    expect(r3.__freed).toBe(false);
    expect(useGtfsDataStore.getState().ptRouter).toBe(r3);
  });

  it("swapPtRouter is null-safe when there is no prior router", () => {
    const r2 = fakeRouter("b");
    useGtfsDataStore.getState().swapPtRouter(r2 as PtRouterHandle);
    expect(useGtfsDataStore.getState().ptRouter).toBe(r2);
  });
});
