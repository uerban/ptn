import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ENGINE_FAILURE_REPORT_KEYS, buildEngineFailureReport, sendEngineFailureReport,
} from "../../src/services/engineFailureReport.ts";

vi.mock("../../src/buildInfo.ts", () => ({
  buildInfo: { version: "test-version", commit: "abc", builtAt: "2026-01-01" },
}));
vi.mock("../../src/stores/privacyStore.ts", () => ({
  getPolicy: vi.fn(() => ({ errorReporting: true })),
}));
vi.mock("../../src/services/api.ts", () => ({
  api: { sendClientReport: vi.fn(async () => {}) },
}));
import { getPolicy } from "../../src/stores/privacyStore.ts";
import { api } from "../../src/services/api.ts";

beforeEach(() => vi.clearAllMocks());

describe("buildEngineFailureReport", () => {
  it("produces EXACTLY {kind, appVersion} — payload is the source of truth", () => {
    const r = buildEngineFailureReport("no-wasm");
    expect(Object.keys(r).sort()).toEqual([...ENGINE_FAILURE_REPORT_KEYS].sort());
    expect(r.kind).toBe("no-wasm");
    expect(typeof r.appVersion).toBe("string");
  });
});

describe("sendEngineFailureReport", () => {
  it("sends when errorReporting is true", async () => {
    (getPolicy as ReturnType<typeof vi.fn>).mockReturnValue({ errorReporting: true });
    await sendEngineFailureReport("import");
    expect(api.sendClientReport).toHaveBeenCalledOnce();
    expect(api.sendClientReport).toHaveBeenCalledWith({ kind: "import", appVersion: expect.any(String) });
  });
  it("does NOT send when errorReporting is false (hardened+ ceiling)", async () => {
    (getPolicy as ReturnType<typeof vi.fn>).mockReturnValue({ errorReporting: false });
    await sendEngineFailureReport("import");
    expect(api.sendClientReport).not.toHaveBeenCalled();
  });
});
