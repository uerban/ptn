import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { RoutingModeIndicator } from "../../src/components/RoutingModeIndicator.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

beforeEach(() => {
  resetFlows();
  useSettingsStore.setState({ routingMode: "on-device", routingProvider: "operator" });
});
const wrap = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("RoutingModeIndicator", () => {
  it("renders nothing in on-device mode", () => {
    allowFlow("operator.remote-routing");
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
  it("shows + links to settings when provider-fallback is active and allowed", () => {
    allowFlow("operator.remote-routing");
    useSettingsStore.setState({ routingMode: "provider-fallback" });
    wrap(<RoutingModeIndicator />);
    expect(screen.getByTestId("routing-mode-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("routing-mode-indicator-change")).toHaveAttribute("href", "/settings#routing-source");
  });
  it("hides while remote routing is not allowed (even if stored mode is provider-fallback)", () => {
    useSettingsStore.setState({ routingMode: "provider-fallback" });
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
  it("shows 'Routing on server' for remote-primary when allowed", () => {
    allowFlow("operator.remote-routing");
    useSettingsStore.setState({ routingMode: "remote-primary" });
    wrap(<RoutingModeIndicator />);
    expect(screen.getByTestId("routing-mode-indicator")).toHaveTextContent("Routing on server");
    expect(screen.getByTestId("routing-mode-indicator-change")).toHaveAttribute("href", "/settings#routing-source");
  });
  it("hides for remote-primary when remote routing is denied", () => {
    denyFlow("operator.remote-routing");
    useSettingsStore.setState({ routingMode: "remote-primary" });
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
  it("follows the decision of the selected provider", () => {
    allowFlow("operator.remote-routing");
    useSettingsStore.setState({ routingMode: "remote-primary", routingProvider: "transitous" });
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
});
