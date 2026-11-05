import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivacyLevel } from "@pt/shared";
import {
  clearErrorBuffer,
  getErrorBuffer,
  reportError,
  reportTelemetry,
} from "../../src/services/errorReporter.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";

function setPrivacyLevel(level: PrivacyLevel): void {
  usePrivacyStore.getState().reset();
  usePrivacyStore.getState().setLevel(level);
}

beforeEach(() => {
  clearErrorBuffer();
  usePrivacyStore.getState().reset();
  globalThis.localStorage?.removeItem("ptn-privacy");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearErrorBuffer();
  usePrivacyStore.getState().reset();
});

describe("reportError — buffer gating per policy.errorReporting", () => {
  it("baseline: buffers full report", () => {
    setPrivacyLevel("baseline");
    reportError(new Error("boom"), { context: { boundary: "map" } });
    const buf = getErrorBuffer();
    expect(buf).toHaveLength(1);
    expect(buf[0]?.message).toBe("boom");
    expect(buf[0]?.context).toEqual({ boundary: "map" });
  });

  it("standard: buffers full report", () => {
    setPrivacyLevel("standard");
    reportError(new Error("boom"));
    expect(getErrorBuffer()).toHaveLength(1);
  });

  it("hardened: does NOT buffer", () => {
    setPrivacyLevel("hardened");
    reportError(new Error("boom"));
    expect(getErrorBuffer()).toHaveLength(0);
  });

  it("strict: does NOT buffer", () => {
    setPrivacyLevel("strict");
    reportError(new Error("boom"));
    expect(getErrorBuffer()).toHaveLength(0);
  });

  it("paranoid: does NOT buffer", () => {
    setPrivacyLevel("paranoid");
    reportError(new Error("boom"));
    expect(getErrorBuffer()).toHaveLength(0);
  });

  it("override loosening past the floor stays gated by floor", () => {
    setPrivacyLevel("hardened");
    // Attempt to loosen via override — ratchet should reject.
    usePrivacyStore.getState().setOverride("errorReporting", true);
    reportError(new Error("boom"));
    expect(getErrorBuffer()).toHaveLength(0);
  });

  it("override tightening below baseline drops buffering", () => {
    setPrivacyLevel("baseline");
    usePrivacyStore.getState().setOverride("errorReporting", false);
    reportError(new Error("boom"));
    expect(getErrorBuffer()).toHaveLength(0);
  });
});

describe("reportError — console output at hardened/strict/paranoid", () => {
  it("hardened: console.error still fires", () => {
    setPrivacyLevel("hardened");
    reportError(new Error("boom"));
    expect(console.error).toHaveBeenCalled();
  });

  it("strict: console.error payload omits stack/componentStack", () => {
    setPrivacyLevel("strict");
    reportError(new Error("boom"), {
      componentStack: "in <App>",
      context: { boundary: "x" },
    });
    expect(console.error).toHaveBeenCalled();
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = call?.[2] as Record<string, unknown> | undefined;
    expect(payload?.stack).toBeUndefined();
    expect(payload?.componentStack).toBeUndefined();
  });

  it("paranoid: console.error payload omits stack/componentStack/context", () => {
    setPrivacyLevel("paranoid");
    reportError(new Error("boom"), {
      componentStack: "in <App>",
      context: { boundary: "x" },
    });
    expect(console.error).toHaveBeenCalled();
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = call?.[2] as Record<string, unknown> | undefined;
    expect(payload?.stack).toBeUndefined();
    expect(payload?.componentStack).toBeUndefined();
    expect(payload?.context).toBeUndefined();
  });

  it("baseline: console.error payload includes stack", () => {
    setPrivacyLevel("baseline");
    const err = new Error("boom");
    err.stack = "Error: boom\n  at x";
    reportError(err);
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = call?.[2] as Record<string, unknown> | undefined;
    expect(payload?.stack).toBeDefined();
  });
});

describe("reportError — buffer ring policy", () => {
  it("evicts oldest when full", () => {
    setPrivacyLevel("baseline");
    for (let i = 0; i < 60; i++) reportError(new Error(`e${i}`));
    const buf = getErrorBuffer();
    expect(buf).toHaveLength(50);
    expect(buf[0]?.message).toBe("e10");
    expect(buf[49]?.message).toBe("e59");
  });
});

describe("reportTelemetry — privacy coupling", () => {
  it("reportTelemetry is suppressed when errorReporting is off (strict/paranoid floor)", async () => {
    await usePrivacyStore.getState().setLevel("paranoid"); // errorReporting=false
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportTelemetry("schedule_tile_served", { stopId: "S1", source: "tile_cold" });
    expect(info).not.toHaveBeenCalled();
    usePrivacyStore.getState().reset(); // standard: errorReporting=true
    reportTelemetry("schedule_tile_served", { stopId: "S1", source: "tile_cold" });
    expect(info).toHaveBeenCalled();
  });
});
