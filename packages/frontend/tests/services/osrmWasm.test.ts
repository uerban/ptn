import { describe, it, expect, beforeEach, vi } from "vitest";
import { OsrmWasmClient } from "../../src/services/osrmWasm.ts";

describe("OsrmWasmClient.init env-flag gate", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Reset the module-scoped one-time-log flag between tests.
    (OsrmWasmClient as unknown as { disabledLogged: boolean }).disabledLogged =
      false;
  });

  it("returns early without throwing when VITE_OSRM_WASM_ENABLED is unset", async () => {
    vi.stubEnv("VITE_OSRM_WASM_ENABLED", "");
    const client = new OsrmWasmClient();
    await expect(client.init("vilnius")).resolves.toBeUndefined();
    expect(client.isReady()).toBe(false);
  });

  it("returns early when VITE_OSRM_WASM_ENABLED is the literal string 'false'", async () => {
    vi.stubEnv("VITE_OSRM_WASM_ENABLED", "false");
    const client = new OsrmWasmClient();
    await expect(client.init("vilnius")).resolves.toBeUndefined();
    expect(client.isReady()).toBe(false);
  });

  it("returns early for ambiguous truthy strings other than 'true'", async () => {
    // Vite envs are always strings; values like "0", "off", "no" must NOT
    // enable the path (they're commonly used to mean disabled). Only
    // exactly "true" enables.
    for (const val of ["0", "off", "no", "disabled", "1"]) {
      vi.stubEnv("VITE_OSRM_WASM_ENABLED", val);
      const client = new OsrmWasmClient();
      await expect(client.init("vilnius")).resolves.toBeUndefined();
      expect(client.isReady(), `value ${val} must not enable`).toBe(false);
    }
  });

  it("attempts the dynamic import when VITE_OSRM_WASM_ENABLED is 'true' (rejects in test env without the WASM module)", async () => {
    vi.stubEnv("VITE_OSRM_WASM_ENABLED", "true");
    const client = new OsrmWasmClient();
    // The WASM module ("osrm-wasm") doesn't exist on npm, so the dynamic
    // import throws. The contract being tested is that init() does NOT
    // short-circuit when the flag is "true" — it actually attempts the
    // integration path. Any future regression that flips the gate's
    // polarity (e.g. to always-return-early) would make this resolve
    // instead of reject.
    await expect(client.init("vilnius")).rejects.toBeDefined();
  });

  it("logs the disabled-state message at most once per session", async () => {
    vi.stubEnv("VITE_OSRM_WASM_ENABLED", "");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await new OsrmWasmClient().init("vilnius");
      await new OsrmWasmClient().init("vilnius");
      await new OsrmWasmClient().init("vilnius");
      const disabledLogs = infoSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[osrm-wasm] disabled"),
      );
      expect(disabledLogs).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
