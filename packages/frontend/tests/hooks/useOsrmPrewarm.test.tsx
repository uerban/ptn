import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useOsrmPrewarm,
  __resetIosNoopLogForTests,
} from "../../src/hooks/useOsrmPrewarm.ts";

// The hook is a thin wrapper around `osrmClient.init`. We mock the module
// up-front (not per-test) so the hook's static import binds to the mock;
// the `initSpy` is reassigned via the factory closure in `beforeEach` so
// each test gets a fresh spy without re-mocking the module.
const initSpy = vi.fn();

vi.mock("../../src/services/osrmWasm.ts", () => ({
  osrmClient: {
    init: (cityId: string) => initSpy(cityId),
    isReady: () => false,
  },
}));

describe("useOsrmPrewarm", () => {
  beforeEach(() => {
    initSpy.mockReset();
    initSpy.mockResolvedValue(undefined);
    __resetIosNoopLogForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("calls osrmClient.init via requestIdleCallback on mount", () => {
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    renderHook(() => useOsrmPrewarm("vilnius"));
    expect(initSpy).toHaveBeenCalledWith("vilnius");
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call init when cityId is the empty string", () => {
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    renderHook(() => useOsrmPrewarm(""));
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("does not call init when requestIdleCallback is unavailable (iOS Safari)", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    renderHook(() => useOsrmPrewarm("vilnius"));
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("logs the iOS-no-op state once per session via console.info", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      renderHook(() => useOsrmPrewarm("vilnius"));
      renderHook(() => useOsrmPrewarm("krakow"));
      renderHook(() => useOsrmPrewarm("paris"));
      const noopLogs = infoSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[osrm-prewarm] disabled"),
      );
      expect(noopLogs).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs a warning with cityId + message when init rejects", async () => {
    initSpy.mockRejectedValue(new Error("404 oslo.osrm"));
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderHook(() => useOsrmPrewarm("oslo"));
      // Allow the microtask queue + the catch handler to run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toMatch(/\[osrm-prewarm\] init failed/);
      expect(message).toMatch(/cityId=oslo/);
      expect(message).toMatch(/404 oslo\.osrm/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not crash when osrmClient.init rejects", async () => {
    initSpy.mockRejectedValue(new Error("init failed"));
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    // Suppress the warn-spam from the previous test's contract.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => renderHook(() => useOsrmPrewarm("vilnius"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initSpy).toHaveBeenCalledWith("vilnius");
  });

  it("calls cancelIdleCallback on unmount when both APIs exist", () => {
    const cancelSpy = vi.fn();
    vi.stubGlobal("requestIdleCallback", () => 42);
    vi.stubGlobal("cancelIdleCallback", cancelSpy);
    const { unmount } = renderHook(() => useOsrmPrewarm("vilnius"));
    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(42);
  });

  it("does not throw on unmount when cancelIdleCallback is missing", () => {
    vi.stubGlobal("requestIdleCallback", () => 42);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const { unmount } = renderHook(() => useOsrmPrewarm("vilnius"));
    expect(() => unmount()).not.toThrow();
  });
});
