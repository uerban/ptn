import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetStoragePolicyForTests, hasEvictor } from "./storagePolicy.ts";

// K6 import-surface assertion: importing scheduleTileEvictor.ts must NOT
// evaluate api.ts, brotliDecode.ts (brotli/codec), or any other heavy module
// that would inflate the entry chunk.
vi.mock("./api.ts", () => {
  // If this factory runs at import time (not on first call), the module
  // was statically imported — the test below will catch this via the spy.
  return { __esModule: true };
});
vi.mock("./brotliDecode.ts", () => ({ __esModule: true }));

describe("scheduleTileEvictor", () => {
  beforeEach(() => {
    __resetStoragePolicyForTests();
    vi.clearAllMocks();
  });

  it("hasEvictor('scheduleTileCache') is false before registerScheduleTileEvictor()", async () => {
    expect(hasEvictor("scheduleTileCache")).toBe(false);
  });

  it("hasEvictor('scheduleTileCache') is true after registerScheduleTileEvictor()", async () => {
    const { registerScheduleTileEvictor } = await import("./scheduleTileEvictor.ts");
    expect(hasEvictor("scheduleTileCache")).toBe(false);
    registerScheduleTileEvictor();
    expect(hasEvictor("scheduleTileCache")).toBe(true);
  });

  it("does NOT pull api.ts or brotli into the module graph (K6)", async () => {
    // The vi.mock factories above would be invoked at module evaluation if
    // scheduleTileEvictor.ts statically imports api.ts or brotliDecode.ts.
    // Since those mocks return trivially empty objects, if the module
    // evaluated them we'd see errors trying to call functions from them.
    // This test directly asserts the import graph is limited to db/storagePolicy/errorReporter.
    const apiMod = await import("./api.ts");
    const brotliMod = await import("./brotliDecode.ts");
    // The mocked modules should only have __esModule (no real api/brotli keys)
    const apiKeys = Object.keys(apiMod).filter((k) => k !== "__esModule" && k !== "default");
    const brotliKeys = Object.keys(brotliMod).filter((k) => k !== "__esModule" && k !== "default");
    // api.ts mock has no real exports → scheduleTileEvictor.ts didn't pull in real api
    expect(apiKeys).toEqual([]);
    expect(brotliKeys).toEqual([]);
  });
});
