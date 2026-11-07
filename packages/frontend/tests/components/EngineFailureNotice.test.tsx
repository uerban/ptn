import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { EngineFailureNotice } from "../../src/components/RouteResults/EngineFailureNotice.tsx";
import { ENGINE_FAILURE_REPORT_KEYS } from "../../src/services/engineFailureReport.ts";
import { denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

// engineFailureReport.ts is loaded for real (via orig()) so the disclosure can
// import the genuine ENGINE_FAILURE_REPORT_KEYS; that pulls in buildInfo.ts,
// whose __BUILD_VERSION__ define is absent under vitest — stub it like the
// engineFailureReport.test.ts service test does.
vi.mock("../../src/buildInfo.ts", () => ({
  buildInfo: { version: "test-version", commit: "abc", builtAt: "2026-01-01" },
}));
vi.mock("../../src/services/engineFailureReport.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/engineFailureReport.ts")>()),
  sendEngineFailureReportOnRequest: vi.fn(async () => {}),
}));
import { sendEngineFailureReportOnRequest } from "../../src/services/engineFailureReport.ts";

beforeEach(() => {
  vi.clearAllMocks();
  resetFlows();
});

describe("EngineFailureNotice", () => {
  it("always shows an honest message + the inline diagnostic (kind)", () => {
    denyFlow("operator.client-report");
    render(<EngineFailureNotice message="wasm engine selected but no PtRouter on store" kind="no-wasm" />);
    expect(screen.getByTestId("engine-error")).toBeInTheDocument();
    expect(screen.getByTestId("engine-failure-diagnostic")).toHaveTextContent("no-wasm");
    // Turned off by the user: the report is not offered.
    expect(screen.queryByTestId("engine-failure-send")).not.toBeInTheDocument();
  });

  it("offers the explicit report while unset and discloses payload plus network metadata", () => {
    render(<EngineFailureNotice message="x" kind="import" />);
    const disclosure = screen.getByTestId("engine-failure-disclosure").textContent ?? "";
    for (const key of ENGINE_FAILURE_REPORT_KEYS) expect(disclosure).toContain(key);
    expect(disclosure).toMatch(/IP address/i);
    expect(disclosure).toMatch(/request time/i);
    expect(disclosure).not.toMatch(/anonymous/i);
    fireEvent.click(screen.getByTestId("engine-failure-send"));
    expect(sendEngineFailureReportOnRequest).toHaveBeenCalledWith("import");
  });

  it("offers 'Search on the server' only when remoteSearch is provided, and calls it", () => {
    const onSearchOnServer = vi.fn();
    const { rerender } = render(
      <EngineFailureNotice message="x" kind="no-wasm" remoteSearch={{ onSearchOnServer }} />,
    );
    const btn = screen.getByTestId("engine-failure-search-server");
    expect(btn).toHaveTextContent(/server/i);
    fireEvent.click(btn);
    expect(onSearchOnServer).toHaveBeenCalledOnce();
    rerender(<EngineFailureNotice message="x" kind="no-wasm" />);
    expect(screen.queryByTestId("engine-failure-search-server")).not.toBeInTheDocument();
  });
});
