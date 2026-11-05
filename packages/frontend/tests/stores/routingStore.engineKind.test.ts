import { describe, it, expect, afterEach } from "vitest";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { __setWasmSupportedForTests } from "../../src/services/probes.ts";

afterEach(() => { __setWasmSupportedForTests(null); useRoutingStore.setState({ engineFailureKind: null, engineError: null }); });

describe("routingStore.engineFailureKind", () => {
  it("defaults to null", () => {
    expect(useRoutingStore.getState().engineFailureKind).toBeNull();
  });
  it("classifies a no-wasm environment when an engine error is recorded", () => {
    __setWasmSupportedForTests(false);
    useRoutingStore.getState().recordEngineFailure(new Error("boom"));
    expect(useRoutingStore.getState().engineFailureKind).toBe("no-wasm");
    expect(useRoutingStore.getState().engineError).toBe("boom");
  });
});
