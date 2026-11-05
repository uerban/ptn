import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { RoutingModeIndicator } from "../../src/components/RoutingModeIndicator.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

vi.mock("../../src/stores/privacyStore.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/stores/privacyStore.ts")>()),
  usePolicy: vi.fn(() => ({ routingAdapter: "user-choice", errorReporting: true })),
}));
import { usePolicy } from "../../src/stores/privacyStore.ts";

beforeEach(() => { vi.clearAllMocks(); useSettingsStore.setState({ routingMode: "on-device" }); });
const wrap = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("RoutingModeIndicator", () => {
  it("renders nothing in on-device mode", () => {
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
  it("shows + links to settings when provider-fallback is active and allowed", () => {
    (usePolicy as ReturnType<typeof vi.fn>).mockReturnValue({ routingAdapter: "user-choice", errorReporting: true });
    useSettingsStore.setState({ routingMode: "provider-fallback" });
    wrap(<RoutingModeIndicator />);
    expect(screen.getByTestId("routing-mode-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("routing-mode-indicator-change")).toHaveAttribute("href", "/settings#routing-source");
  });
  it("hides when the privacy ceiling forbids remote (even if stored mode is provider-fallback)", () => {
    (usePolicy as ReturnType<typeof vi.fn>).mockReturnValue({ routingAdapter: "local-only", errorReporting: false });
    useSettingsStore.setState({ routingMode: "provider-fallback" });
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
  it("shows 'Routing on server' for remote-primary when allowed", () => {
    (usePolicy as ReturnType<typeof vi.fn>).mockReturnValue({ routingAdapter: "user-choice", errorReporting: true });
    useSettingsStore.setState({ routingMode: "remote-primary" });
    wrap(<RoutingModeIndicator />);
    expect(screen.getByTestId("routing-mode-indicator")).toHaveTextContent("Routing on server");
    expect(screen.getByTestId("routing-mode-indicator-change")).toHaveAttribute("href", "/settings#routing-source");
  });
  it("hides for remote-primary at local-only", () => {
    (usePolicy as ReturnType<typeof vi.fn>).mockReturnValue({ routingAdapter: "local-only", errorReporting: false });
    useSettingsStore.setState({ routingMode: "remote-primary" });
    wrap(<RoutingModeIndicator />);
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });
});
