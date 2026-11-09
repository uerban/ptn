import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "../../src/pages/Settings.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import * as availability from "../../src/services/remoteRoutingAvailability.ts";

import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import { getNetworkDecision } from "../../src/privacy/canUse.ts";
import { denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

beforeEach(() => {
  vi.clearAllMocks();
  resetFlows();
  usePrivacyStore.getState().reset();
  useSettingsStore.setState({
    routingMode: "on-device",
    routingProvider: "operator",
  });
  // Default the remote source to "up" so no unavailable hint renders unless a
  // case opts in. The real hook fires a bounded probe that fail-closes to false
  // in jsdom (no fetch); spying keeps these existing cases deterministic.
  vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(true);
});

afterEach(() => {
  // Restore the real hook so each case re-spies from the pristine export
  // (a standing spy left mocked across cases otherwise wins over a re-spy).
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function renderSettings() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
}

describe("Settings — Routing source", () => {
  it("choosing provider-fallback allows the selected provider's routing", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-mode-provider-fallback"));
    expect(useSettingsStore.getState().routingMode).toBe("provider-fallback");
    expect(getNetworkDecision("operator.remote-routing")).toEqual({ value: "allowed", source: "settings" });
    expect(getNetworkDecision("external.remote-routing", "transitous").value).toBe("unset");
  });

  it("keeps the remote modes selectable at every level", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    renderSettings();
    expect(screen.getByTestId("routing-mode-provider-fallback")).not.toBeDisabled();
    expect(screen.getByTestId("routing-mode-remote-primary")).not.toBeDisabled();
    expect(screen.getByTestId("routing-provider-transitous")).not.toBeDisabled();
  });

  it("choosing on-device never rewrites a decision", () => {
    denyFlow("operator.remote-routing");
    useSettingsStore.setState({ routingMode: "remote-primary" });
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-mode-on-device"));
    expect(useSettingsStore.getState().routingMode).toBe("on-device");
    expect(getNetworkDecision("operator.remote-routing").value).toBe("denied");
  });

  it("renders all three routing modes", () => {
    renderSettings();
    expect(screen.getByTestId("routing-mode-on-device")).toBeInTheDocument();
    expect(screen.getByTestId("routing-mode-provider-fallback")).toBeInTheDocument();
    expect(screen.getByTestId("routing-mode-remote-primary")).toBeInTheDocument();
  });

  it("selects remote-primary", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-mode-remote-primary"));
    expect(useSettingsStore.getState().routingMode).toBe("remote-primary");
  });

  it("persists transitous as the standing remote provider without allowing it while on-device", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-provider-transitous"));
    expect(useSettingsStore.getState().routingProvider).toBe("transitous");
    expect(screen.getByText(/Shared fields: from, to, departAt/i)).toBeVisible();
    expect(getNetworkDecision("external.remote-routing", "transitous").value).toBe("unset");
  });

  it("choosing transitous with a remote mode allows exactly that provider", () => {
    useSettingsStore.setState({ routingMode: "remote-primary" });
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-provider-transitous"));
    expect(getNetworkDecision("external.remote-routing", "transitous")).toEqual({
      value: "allowed",
      source: "settings",
    });
    expect(getNetworkDecision("operator.remote-routing").value).toBe("unset");
  });

  // Availability hint: when the source is currently DOWN, the remote modes
  // stay selectable but show a "currently unavailable" hint.
  it("shows a 'server unavailable' hint on remote modes when the source is down", () => {
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(false);
    renderSettings();
    // Both remote modes are enabled but flagged unavailable.
    expect(screen.getAllByText("Server unavailable right now").length).toBeGreaterThan(0);
    expect(screen.getByTestId("routing-mode-remote-primary")).not.toBeDisabled();
    expect(screen.getByTestId("routing-mode-provider-fallback")).not.toBeDisabled();
  });

  it("no unavailable hint when the source is up", () => {
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(true);
    renderSettings();
    expect(screen.queryByText("Server unavailable right now")).not.toBeInTheDocument();
  });
});
