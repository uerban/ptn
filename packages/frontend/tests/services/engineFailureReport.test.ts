import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ENGINE_FAILURE_REPORT_KEYS,
  buildEngineFailureReport,
  canOfferEngineFailureReport,
  sendEngineFailureReport,
  sendEngineFailureReportOnRequest,
} from "../../src/services/engineFailureReport.ts";
import { getNetworkDecision } from "../../src/privacy/canUse.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

vi.mock("../../src/buildInfo.ts", () => ({
  buildInfo: { version: "test-version", commit: "abc", builtAt: "2026-01-01" },
}));
vi.mock("../../src/services/api.ts", () => ({
  api: { sendClientReport: vi.fn(async () => {}) },
}));
import { api } from "../../src/services/api.ts";

beforeEach(() => {
  vi.clearAllMocks();
  resetFlows();
});

describe("buildEngineFailureReport", () => {
  it("produces EXACTLY {kind, appVersion} — payload is the source of truth", () => {
    const r = buildEngineFailureReport("no-wasm");
    expect(Object.keys(r).sort()).toEqual([...ENGINE_FAILURE_REPORT_KEYS].sort());
    expect(r.kind).toBe("no-wasm");
    expect(typeof r.appVersion).toBe("string");
  });
});

describe("sendEngineFailureReport", () => {
  it("sends once the report flow is allowed", async () => {
    allowFlow("operator.client-report");
    await sendEngineFailureReport("import");
    expect(api.sendClientReport).toHaveBeenCalledOnce();
    expect(api.sendClientReport).toHaveBeenCalledWith({ kind: "import", appVersion: expect.any(String) });
  });
  it("does NOT send while the report flow is unset or denied", async () => {
    await sendEngineFailureReport("import");
    denyFlow("operator.client-report");
    await sendEngineFailureReport("import");
    expect(api.sendClientReport).not.toHaveBeenCalled();
  });
});

describe("sendEngineFailureReportOnRequest", () => {
  it("the explicit click records a contextual decision and sends", async () => {
    expect(canOfferEngineFailureReport()).toBe(true);
    await sendEngineFailureReportOnRequest("no-wasm");
    expect(getNetworkDecision("operator.client-report")).toEqual({
      value: "allowed",
      source: "contextual",
    });
    expect(api.sendClientReport).toHaveBeenCalledOnce();
  });
});
