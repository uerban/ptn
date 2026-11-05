import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { StopPopup } from "./StopPopup.tsx";

vi.mock("../../i18n/index.ts", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

vi.mock("../../stores/settingsStore.ts", () => ({
  useSettingsStore: (sel: (s: { departuresPerLine: number; maxPopupLines: number; modeColorOverrides: Record<string, unknown>; accessibilityScheme: string; resolvedTheme: string; highContrastEnabled: boolean }) => unknown) =>
    sel({
      departuresPerLine: 3,
      maxPopupLines: 5,
      modeColorOverrides: {},
      accessibilityScheme: "default",
      resolvedTheme: "light",
      highContrastEnabled: false,
    }),
}));

vi.mock("../../stores/cityStore.ts", () => ({
  useCityStore: (sel: (s: { activeCity: { id: string } }) => unknown) =>
    sel({ activeCity: { id: "vilnius" } }),
}));

vi.mock("../../stores/colorConfigStore.ts", () => ({
  useColorConfigStore: (sel: (s: { config: null }) => unknown) => sel({ config: null }),
}));

vi.mock("../../hooks/useCountdown.ts", () => ({
  useCountdown: () => [],
}));

vi.mock("../ModeFilterPills.tsx", () => ({
  ModeFilterPills: () => null,
}));

vi.mock("../Icon.tsx", () => ({
  Icon: () => null,
}));

vi.mock("../../utils/groupDeparturesByLine.ts", () => ({
  groupDeparturesByLine: () => [],
}));

const noop = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("StopPopup cold-load affordance", () => {
  test("popup-loading-slow is absent immediately when loading=true", () => {
    render(
      <StopPopup
        stopName="Test Stop"
        departures={[]}
        loading={true}
        onSeeAll={noop}
      />,
    );
    expect(screen.queryByTestId("popup-loading-slow")).toBeNull();
  });

  test("popup-loading-slow appears after 1500ms when loading=true", () => {
    render(
      <StopPopup
        stopName="Test Stop"
        departures={[]}
        loading={true}
        onSeeAll={noop}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByTestId("popup-loading-slow")).not.toBeNull();
  });

  test("popup-loading-slow is absent when loading=false", () => {
    render(
      <StopPopup
        stopName="Test Stop"
        departures={[]}
        loading={false}
        onSeeAll={noop}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByTestId("popup-loading-slow")).toBeNull();
  });
});
