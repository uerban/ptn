import { describe, it, expect, afterEach } from "vitest";
import { classifyEngineFailure } from "../../src/services/engineFailure.ts";
import { __setWasmSupportedForTests } from "../../src/services/probes.ts";
import {
  PtEngineMisconfiguredError,
  PtWasmImportError, PtWasmInitError, PtWasmQueryError, PtWasmTransfersError,
} from "../../src/services/raptorWasm.ts";

afterEach(() => __setWasmSupportedForTests(null));

describe("classifyEngineFailure", () => {
  it("classifies no-wasm first, regardless of the error instance", () => {
    __setWasmSupportedForTests(false);
    expect(classifyEngineFailure(new PtEngineMisconfiguredError("x"))).toBe("no-wasm");
    expect(classifyEngineFailure(new Error("anything"))).toBe("no-wasm");
  });
  it("maps each wasm error class to its kind when wasm IS supported", () => {
    __setWasmSupportedForTests(true);
    expect(classifyEngineFailure(new PtWasmImportError("c"))).toBe("import");
    expect(classifyEngineFailure(new PtWasmInitError("c"))).toBe("init");
    expect(classifyEngineFailure(new PtEngineMisconfiguredError("c"))).toBe("init");
    expect(classifyEngineFailure(new PtWasmQueryError("c"))).toBe("query");
    expect(classifyEngineFailure(new PtWasmTransfersError("c"))).toBe("query");
    expect(classifyEngineFailure(new Error("unknown"))).toBe("other");
  });
});
