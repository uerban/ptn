import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { StopMarker } from "../../src/components/Map/StopMarker.tsx";
import { LineGroup } from "../../src/components/DepartureSheet/LineGroup.tsx";
import { TransportModeIcon } from "../../src/components/TransportModeIcon.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { DEFAULT_MODE_COLORS, MONOCHROME_PATTERNS } from "../../src/utils/routeColor.ts";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

beforeEach(() => {
  const store = useSettingsStore.getState();
  store.setAccessibilityScheme("none");
  store.resetModeColorOverrides();
});

describe("StopMarker color resolution", () => {
  const baseLines = [
    { routeId: "r1", shortName: "3G", color: "e53935", mode: "BUS" as const },
  ];

  it("uses GTFS color when no override or scheme", () => {
    const { container } = render(
      <StopMarker name="Stop" lines={baseLines} offset={{ dx: 20, dy: 20 }} />,
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("#e53935");
  });

  it("uses user override over GTFS color", () => {
    useSettingsStore.getState().setModeColorOverride("BUS", "#ff00ff");
    const { container } = render(
      <StopMarker name="Stop" lines={baseLines} offset={{ dx: 20, dy: 20 }} />,
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("#ff00ff");
    expect(style).not.toContain("#e53935");
  });

  it("uses default color when scheme active but no colorConfig", () => {
    useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
    const lines = [{ routeId: "r1", shortName: "3G", mode: "BUS" as const }];
    const { container } = render(
      <StopMarker name="Stop" lines={lines} offset={{ dx: 20, dy: 20 }} />,
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain(DEFAULT_MODE_COLORS.BUS);
  });

  it("uses default color as last resort", () => {
    const lines = [{ routeId: "r1", shortName: "3G", mode: "BUS" as const }];
    const { container } = render(
      <StopMarker name="Stop" lines={lines} offset={{ dx: 20, dy: 20 }} />,
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain(DEFAULT_MODE_COLORS.BUS);
  });

  it("uses monochrome pattern with textStroke when scheme is monochrome", () => {
    useSettingsStore.getState().setAccessibilityScheme("monochrome");
    const lines = [{ routeId: "r1", shortName: "3G", mode: "BUS" as const }];
    const { container } = render(
      <StopMarker name="Stop" lines={lines} offset={{ dx: 20, dy: 20 }} />,
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("repeating-linear-gradient");
    expect(style).toContain("-webkit-text-stroke");
  });
});

describe("LineGroup color resolution", () => {
  const baseDeps = [
    {
      routeId: "r1",
      routeShortName: "6N",
      routeColor: "1e88e5",
      mode: "TRAM" as const,
      headsign: "Centre",
      scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      tripId: "t1",
    },
  ];

  it("uses GTFS color when no override or scheme", () => {
    const { container } = render(
      <LineGroup routeShortName="6N" routeColor="1e88e5" mode="TRAM" headsign="Centre" departures={baseDeps} />,
      { wrapper: Wrapper },
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("#1e88e5");
  });

  it("uses user override over GTFS color", () => {
    useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
    const { container } = render(
      <LineGroup routeShortName="6N" routeColor="1e88e5" mode="TRAM" headsign="Centre" departures={baseDeps} />,
      { wrapper: Wrapper },
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("#00ff00");
  });

  it("uses monochrome pattern when scheme is monochrome and no GTFS color", () => {
    useSettingsStore.getState().setAccessibilityScheme("monochrome");
    const { container } = render(
      <LineGroup routeShortName="6N" mode="TRAM" headsign="Centre" departures={baseDeps} />,
      { wrapper: Wrapper },
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    // TRAM monochrome light uses a radial-gradient pattern
    expect(style).toContain(MONOCHROME_PATTERNS.TRAM.light.background);
  });

  it("uses default color as last resort", () => {
    const { container } = render(
      <LineGroup routeShortName="6N" mode="TRAM" headsign="Centre" departures={baseDeps} />,
      { wrapper: Wrapper },
    );
    const badge = container.querySelector("span[style]");
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain(DEFAULT_MODE_COLORS.TRAM);
  });
});

describe("TransportModeIcon color resolution", () => {
  it("uses default mode color when no override or scheme", () => {
    const { container } = render(<TransportModeIcon mode="METRO" />);
    const span = container.querySelector("span");
    const style = span?.getAttribute("style") ?? "";
    expect(style).toContain(DEFAULT_MODE_COLORS.METRO);
  });

  it("uses user override when set", () => {
    useSettingsStore.getState().setModeColorOverride("METRO", "#abcdef");
    const { container } = render(<TransportModeIcon mode="METRO" />);
    const span = container.querySelector("span");
    const style = span?.getAttribute("style") ?? "";
    expect(style).toContain("#abcdef");
  });

  it("uses scheme color when scheme is active", () => {
    useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
    const { container } = render(<TransportModeIcon mode="METRO" />);
    const span = container.querySelector("span");
    const style = span?.getAttribute("style") ?? "";
    expect(style).toContain(DEFAULT_MODE_COLORS.METRO);
  });

  it("sets --route-color CSS variable for transition support", () => {
    const { container } = render(<TransportModeIcon mode="BUS" />);
    const span = container.querySelector("span");
    const style = span?.getAttribute("style") ?? "";
    expect(style).toContain("--route-color");
  });

  it("uses monochrome pattern and textStroke when scheme is monochrome", () => {
    useSettingsStore.getState().setAccessibilityScheme("monochrome");
    const { container } = render(<TransportModeIcon mode="BUS" />);
    const span = container.querySelector("span");
    const style = span?.getAttribute("style") ?? "";
    expect(style).toContain("repeating-linear-gradient");
    expect(style).toContain("-webkit-text-stroke");
  });
});
