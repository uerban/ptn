// packages/frontend/tests/services/probes.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { wasmSupported, __setWasmSupportedForTests } from "../../src/services/probes.ts";

afterEach(() => __setWasmSupportedForTests(null));

describe("wasmSupported", () => {
  it("returns a boolean from the real environment by default", () => {
    expect(typeof wasmSupported()).toBe("boolean");
  });
  it("is overridable for tests (so no-wasm devices are simulatable in jsdom)", () => {
    __setWasmSupportedForTests(false);
    expect(wasmSupported()).toBe(false);
    __setWasmSupportedForTests(true);
    expect(wasmSupported()).toBe(true);
  });
});
