import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "../../src/pages/Settings.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import * as availability from "../../src/services/remoteRoutingAvailability.ts";

vi.mock("../../src/stores/privacyStore.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/stores/privacyStore.ts")>()),
  usePolicy: vi.fn(() => ({
    routingAdapter: "user-choice",
    errorReporting: true,
    recentsEncryption: "plaintext",
    savesEncryption: "opt-in",
    mapTapPersistedPrecision: "raw",
    mapTapSnapRadiusMeters: 0,
    m9SelfHosted: "respect-multitenant",
    m10ThirdPartyEnabled: true,
    m10CoarsenGridFloorMeters: 0,
    m10CoarsenGridDefaultMeters: 0,
    m10Jitter: false,
    m11TileDefense: "none",
    m10DedupCache: "plaintext-30d",
    providerFallback: "silent",
    urlShare: "coords-raw",
    m11TileCacheBudgetBytes: 100_000_000,
    poiResidency: "user-choice",
    realTimePolling: "backend-adaptive",
  })),
}));
import { usePolicy } from "../../src/stores/privacyStore.ts";

beforeEach(() => {
  vi.clearAllMocks();
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
  // Vitest 4's restoreAllMocks no longer touches vi.fn mocks, so reset the
  // mocked usePolicy too, or one case's mockReturnValue leaks into the next.
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function renderSettings() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
}

function mockLocalOnly() {
  (usePolicy as ReturnType<typeof vi.fn>).mockReturnValue({
    routingAdapter: "local-only",
    errorReporting: false,
    recentsEncryption: "encrypted-30d",
    savesEncryption: "always",
    mapTapPersistedPrecision: "snap-rounded-50m",
    mapTapSnapRadiusMeters: 50,
    m9SelfHosted: "always-coarsen",
    m10ThirdPartyEnabled: false,
    m10CoarsenGridFloorMeters: 50,
    m10CoarsenGridDefaultMeters: 100,
    m10Jitter: true,
    m11TileDefense: "prefetch-padding",
    m10DedupCache: "encrypted-1d",
    providerFallback: "visible",
    urlShare: "coords-stripped",
    m11TileCacheBudgetBytes: 25_000_000,
    poiResidency: "local-only",
    realTimePolling: "backend-foreground-only",
  });
}

describe("Settings — Routing source", () => {
  it("selects provider-fallback when allowed", () => {
    (usePolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      routingAdapter: "user-choice",
      errorReporting: true,
      recentsEncryption: "plaintext",
      savesEncryption: "opt-in",
      mapTapPersistedPrecision: "raw",
      mapTapSnapRadiusMeters: 0,
      m9SelfHosted: "respect-multitenant",
      m10ThirdPartyEnabled: true,
      m10CoarsenGridFloorMeters: 0,
      m10CoarsenGridDefaultMeters: 0,
      m10Jitter: false,
      m11TileDefense: "none",
      m10DedupCache: "plaintext-30d",
      providerFallback: "silent",
      urlShare: "coords-raw",
      m11TileCacheBudgetBytes: 100_000_000,
      poiResidency: "user-choice",
      realTimePolling: "backend-adaptive",
    });
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-mode-provider-fallback"));
    expect(useSettingsStore.getState().routingMode).toBe("provider-fallback");
  });
  it("disables the provider-fallback option at local-only", () => {
    mockLocalOnly();
    renderSettings();
    expect(screen.getByTestId("routing-mode-provider-fallback")).toBeDisabled();
  });

  it("renders all three routing modes", () => {
    renderSettings();
    expect(screen.getByTestId("routing-mode-on-device")).toBeInTheDocument();
    expect(screen.getByTestId("routing-mode-provider-fallback")).toBeInTheDocument();
    expect(screen.getByTestId("routing-mode-remote-primary")).toBeInTheDocument();
  });

  it("disables BOTH remote modes at local-only", () => {
    mockLocalOnly();
    renderSettings();
    expect(screen.getByTestId("routing-mode-provider-fallback")).toBeDisabled();
    expect(screen.getByTestId("routing-mode-remote-primary")).toBeDisabled();
    expect(screen.getByTestId("routing-mode-on-device")).not.toBeDisabled();
  });

  it("selects remote-primary", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-mode-remote-primary"));
    expect(useSettingsStore.getState().routingMode).toBe("remote-primary");
  });

  it("persists transitous as the standing remote provider", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("routing-provider-transitous"));
    expect(useSettingsStore.getState().routingProvider).toBe("transitous");
    expect(screen.getByText(/Shared fields: from, to, departAt/i)).toBeVisible();
  });

  it("keeps transitous inert when third-party egress is disabled", () => {
    mockLocalOnly();
    useSettingsStore.setState({ routingProvider: "transitous" });
    renderSettings();
    expect(screen.getByTestId("routing-provider-transitous")).toBeDisabled();
    expect(screen.getByTestId("routing-provider-operator")).toBeEnabled();
    fireEvent.click(screen.getByTestId("routing-provider-operator"));
    expect(useSettingsStore.getState().routingProvider).toBe("operator");
  });

  // Availability hint: when remote routing is ALLOWED
  // (user-choice) but the source is currently DOWN, the remote modes stay
  // selectable (it's a user choice, not a privacy block) but show a
  // "currently unavailable" hint — sibling of the privacy-blocked hint.
  it("shows a 'server unavailable' hint on remote modes when the source is down", () => {
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(false);
    renderSettings();
    // Both remote modes are enabled (user-choice) but flagged unavailable.
    expect(screen.getAllByText("Server unavailable right now").length).toBeGreaterThan(0);
    expect(screen.getByTestId("routing-mode-remote-primary")).not.toBeDisabled();
    expect(screen.getByTestId("routing-mode-provider-fallback")).not.toBeDisabled();
  });

  it("no unavailable hint when the source is up", () => {
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(true);
    renderSettings();
    expect(screen.queryByText("Server unavailable right now")).not.toBeInTheDocument();
  });

  // Mutual exclusivity: the blocked hint ("Off at your
  // privacy level") and the unavailable hint ("Server unavailable right now")
  // can never co-render on the same mode. When privacy BLOCKS remote routing
  // (local-only ⇒ `disabled`) AND the source is also down, the blocked hint
  // wins and the unavailable hint is suppressed by the `!disabled` guard.
  it("shows ONLY the blocked hint (not the unavailable hint) when privacy-blocked AND down", () => {
    mockLocalOnly();
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(false);
    renderSettings();
    // The privacy-blocked hint is present on the disabled remote modes…
    expect(screen.getAllByText("Off at your privacy level").length).toBeGreaterThan(0);
    // …and the availability hint is fully suppressed (the `!disabled` guard).
    expect(screen.queryByText("Server unavailable right now")).not.toBeInTheDocument();
    expect(screen.queryByTestId("routing-mode-remote-primary-unavailable")).not.toBeInTheDocument();
    expect(screen.queryByTestId("routing-mode-provider-fallback-unavailable")).not.toBeInTheDocument();
  });
});
