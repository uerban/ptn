import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../i18n/index.ts";
import { MAP_DETAIL_ASKED_KEY, MapDetailControl } from "./MapDetailControl.tsx";
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

const disclosure = () => screen.queryByTestId("flow-disclosure");

beforeEach(() => {
  localStorage.removeItem(MAP_DETAIL_ASKED_KEY);
  useNetworkDecisionsStore.getState().reset();
  useSettingsStore.getState().setMapDetailMode("micromap");
  __resetContextualPromptsForTests();
  reportDetailedBasemapStatus("off");
  micromap.state = undefined;
  micromap.load.mockClear();
});

afterEach(cleanup);

describe("MapDetailControl", () => {
  it("has no standing toggle", () => {
    renderControl();
    expect(screen.queryByTestId("more-map-detail")).toBeNull();
    expect(screen.queryByText("More map detail")).toBeNull();
  });

  it("asks once, naming the provider, and Use detailed maps grants that provider only", () => {
    renderControl();
    const dialog = screen.getByTestId("flow-disclosure");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain("CARTO");
    expect(canUse("external.detailed-basemap", "carto")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Use detailed maps" }));
    expect(canUse("external.detailed-basemap", "carto")).toBe(true);
    expect(Object.keys(useNetworkDecisionsStore.getState().decisions)).toEqual([
      "external.detailed-basemap@carto",
    ]);
    expect(useSettingsStore.getState().mapDetailMode).toBe("detailed");
    expect(disclosure()).toBeNull();
    expect(localStorage.getItem(MAP_DETAIL_ASKED_KEY)).toBe("1");
  });

  it("Not now keeps the local map and is never asked again, even after a reload", () => {
    const view = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
    expect(disclosure()).toBeNull();
    view.unmount();

    __resetContextualPromptsForTests();
    renderControl();
    expect(disclosure()).toBeNull();
    expect(useSettingsStore.getState().mapDetailMode).toBe("micromap");
  });

  it("Don't ask again records a denial and stays silent", () => {
    const view = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Don't ask again" }));
    expect(
      useNetworkDecisionsStore.getState().decisions["external.detailed-basemap@carto"]?.value,
    ).toBe("denied");
    view.unmount();

    __resetContextualPromptsForTests();
    renderControl();
    expect(disclosure()).toBeNull();
  });

  it("does not ask when detailed maps are already allowed or decided", () => {
    useNetworkDecisionsStore
      .getState()
      .setDecision("external.detailed-basemap", "allowed", "settings", "carto");
    renderControl();
    expect(disclosure()).toBeNull();
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
    useSettingsStore.getState().setMapDetailMode("detailed");
    renderControl();
    act(() => reportDetailedBasemapStatus("loading"));
    expect(screen.getByTestId("map-status").textContent).toContain("Loading detailed map");
    act(() => reportDetailedBasemapStatus("failed"));
    expect(screen.getByTestId("map-status").textContent).toContain(
      "Detailed map unavailable. Showing the minimal map.",
    );
  });
});
