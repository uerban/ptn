import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../i18n/index.ts";
import { MAP_DETAIL_HINT_KEY, MapDetailControl } from "./MapDetailControl.tsx";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { canUse } from "../../privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../../privacy/contextualPrompts.ts";
import { reportDetailedBasemapStatus } from "../../services/basemapPrivacy.ts";

const micromap = vi.hoisted(() => ({
  state: undefined as string | undefined,
  load: vi.fn(async () => null),
}));
vi.mock("../../services/micromapLoader.ts", () => ({
  useMicromapState: () => micromap.state,
  loadMicromap: micromap.load,
}));

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider
      value={{
        locale: "en",
        formattingLocale: "en",
        t: (key, fallback) => fallback ?? key,
        privacyReady: true,
        ensurePrivacyNamespace: () => {},
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

function renderControl() {
  return render(<MapDetailControl />, { wrapper: Wrapper });
}

const moreDetail = () => screen.getByTestId("more-map-detail");
const hint = () => screen.queryByTestId("map-detail-hint");

beforeEach(() => {
  localStorage.removeItem(MAP_DETAIL_HINT_KEY);
  useNetworkDecisionsStore.getState().reset();
  useSettingsStore.getState().setMapDetailMode("detailed");
  __resetContextualPromptsForTests();
  reportDetailedBasemapStatus("off");
  micromap.state = undefined;
  micromap.load.mockClear();
});

afterEach(cleanup);

describe("MapDetailControl", () => {
  it("offers More map detail at once, with a quiet tip that takes no focus", () => {
    renderControl();
    expect(moreDetail().getAttribute("aria-pressed")).toBe("false");
    expect(hint()).not.toBeNull();
    expect(hint()?.getAttribute("role")).toBeNull();
    expect(hint()?.getAttribute("aria-live")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("remembers a dismissed tip across reloads and keeps the control", () => {
    const view = renderControl();
    fireEvent.click(screen.getByTestId("map-detail-hint-dismiss"));
    expect(hint()).toBeNull();
    view.unmount();

    renderControl();
    expect(hint()).toBeNull();
    expect(moreDetail()).toBeDefined();
  });

  it("asks first, naming the provider, and Use detailed maps grants that provider only", () => {
    renderControl();
    fireEvent.click(moreDetail());
    const disclosure = screen.getByTestId("flow-disclosure");
    expect(disclosure.getAttribute("role")).toBe("dialog");
    expect(disclosure.textContent).toContain("CARTO");
    expect(disclosure.textContent).toContain("The map area on screen");
    expect(canUse("external.detailed-basemap", "carto")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Use detailed maps" }));
    expect(canUse("external.detailed-basemap", "carto")).toBe(true);
    expect(Object.keys(useNetworkDecisionsStore.getState().decisions)).toEqual([
      "external.detailed-basemap@carto",
    ]);
    expect(useSettingsStore.getState().mapDetailMode).toBe("detailed");
    expect(moreDetail().getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(moreDetail());
  });

  it("Not now keeps the local map and hides the tip for the session", () => {
    const view = renderControl();
    fireEvent.click(moreDetail());
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
    view.unmount();

    // Same session, tip not dismissed in storage: still not offered again.
    localStorage.removeItem(MAP_DETAIL_HINT_KEY);
    renderControl();
    expect(hint()).toBeNull();
    // The deliberate action still opens the disclosure.
    fireEvent.click(moreDetail());
    expect(screen.getByTestId("flow-disclosure")).toBeDefined();
  });

  it("Don't ask again silences the tip, but the control still opens the disclosure with Allow", () => {
    const view = renderControl();
    fireEvent.click(moreDetail());
    fireEvent.click(screen.getByRole("button", { name: "Don't ask again" }));
    expect(
      useNetworkDecisionsStore.getState().decisions["external.detailed-basemap@carto"]?.value,
    ).toBe("denied");
    view.unmount();
    localStorage.removeItem(MAP_DETAIL_HINT_KEY);
    __resetContextualPromptsForTests();

    renderControl();
    expect(hint()).toBeNull();
    fireEvent.click(moreDetail());
    expect(screen.queryByRole("button", { name: "Don't ask again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use detailed maps" }));
    expect(canUse("external.detailed-basemap", "carto")).toBe(true);
  });

  it("switches directly when detailed maps are already allowed, and back without revoking", () => {
    useNetworkDecisionsStore
      .getState()
      .setDecision("external.detailed-basemap", "allowed", "settings", "carto");
    useSettingsStore.getState().setMapDetailMode("micromap");
    renderControl();
    expect(hint()).toBeNull();

    fireEvent.click(moreDetail());
    expect(screen.queryByTestId("flow-disclosure")).toBeNull();
    expect(useSettingsStore.getState().mapDetailMode).toBe("detailed");

    fireEvent.click(moreDetail());
    expect(useSettingsStore.getState().mapDetailMode).toBe("micromap");
    expect(canUse("external.detailed-basemap", "carto")).toBe(true);
  });

  it("follows a revocation made elsewhere", () => {
    useNetworkDecisionsStore
      .getState()
      .setDecision("external.detailed-basemap", "allowed", "settings", "carto");
    renderControl();
    expect(moreDetail().getAttribute("aria-pressed")).toBe("true");
    act(() => {
      useNetworkDecisionsStore
        .getState()
        .setDecision("external.detailed-basemap", "denied", "settings", "carto");
    });
    expect(moreDetail().getAttribute("aria-pressed")).toBe("false");
  });

  it.each([
    ["loading", "Loading the minimal map…", false],
    ["absent", "This city has no minimal map yet.", false],
    ["failed", "could not be loaded", true],
    ["offline", "needs a connection the first time", true],
  ])("states a %s minimal map", (state, message, retry) => {
    micromap.state = state;
    renderControl();
    const status = screen.getByTestId("map-status");
    expect(status.textContent).toContain(message);
    if (state !== "loading") expect(status.textContent).toContain("Transit routes only");
    const button = screen.queryByRole("button", { name: "Try again" });
    expect(button !== null).toBe(retry);
    if (button) {
      fireEvent.click(button);
      expect(micromap.load).toHaveBeenCalled();
    }
  });

  it("shows no status for a ready or device-cached minimal map, but tells them apart", () => {
    micromap.state = "cached";
    renderControl();
    expect(screen.queryByTestId("map-status")).toBeNull();
    expect(screen.getByTestId("map-detail-control").dataset.micromapState).toBe("cached");
  });

  it("states a detailed map that is loading or failed", () => {
    useNetworkDecisionsStore
      .getState()
      .setDecision("external.detailed-basemap", "allowed", "settings", "carto");
    renderControl();
    act(() => reportDetailedBasemapStatus("loading"));
    expect(screen.getByTestId("map-status").textContent).toContain("Loading detailed map");
    act(() => reportDetailedBasemapStatus("failed"));
    expect(screen.getByTestId("map-status").textContent).toContain(
      "Detailed map unavailable. Showing the minimal map.",
    );
  });
});
