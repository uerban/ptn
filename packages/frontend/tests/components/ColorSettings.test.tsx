import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { ColorSettings, translatedSubModeLabel } from "../../src/components/Settings/ColorSettings.tsx";
import type { SubModeEntry } from "@pt/shared";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useColorConfigStore } from "../../src/stores/colorConfigStore.ts";
import { useStopStore } from "../../src/stores/stopStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { DEFAULT_MODE_COLORS } from "../../src/utils/routeColor.ts";
import { CITIES } from "../../src/config/cities.ts";
import type { ColorConfig } from "@pt/shared";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const MOCK_STOPS = [
  {
    id: "s1",
    name: "Stop 1",
    location: { lat: 54.68, lon: 25.28 },
    lastSeen: Date.now(),
    lines: [
      { routeId: "r1", shortName: "3G", color: "#ff0000", mode: "BUS" as const },
      { routeId: "r2", shortName: "6N", color: "#00ff00", mode: "TRAM" as const },
    ],
  },
  {
    id: "s2",
    name: "Stop 2",
    location: { lat: 54.69, lon: 25.29 },
    lastSeen: Date.now(),
    lines: [
      { routeId: "r3", shortName: "M1", color: "#0000ff", mode: "METRO" as const },
      { routeId: "r4", shortName: "R2", mode: "RAIL" as const },
    ],
  },
];

const MOCK_COLOR_CONFIG: ColorConfig = {
  modes: [
    { id: "BUS", label: "Bus (blue)", parentMode: "BUS", color: "#0073AC", routeCount: 35, sampleRoutes: ["3G", "1", "2"] },
    { id: "BUS:night", label: "Bus (black)", parentMode: "BUS", color: "#111111", routeCount: 5, sampleRoutes: ["N1", "N2"] },
    { id: "TRAM", label: "Tram (green)", parentMode: "TRAM", color: "#16a34a", routeCount: 10, sampleRoutes: ["6N", "T2"] },
    { id: "METRO", label: "Metro (red)", parentMode: "METRO", color: "#dc2626", routeCount: 3, sampleRoutes: ["M1"] },
  ],
  palettes: {
    light: {
      universal: { BUS: "#2B7AB5", "BUS:night": "#3A3A5C", TRAM: "#5BAA55", METRO: "#CC4444" },
      deuteranopia: { BUS: "#3366CC", "BUS:night": "#444466", TRAM: "#CC8833", METRO: "#8844CC" },
      protanopia: { BUS: "#2255BB", "BUS:night": "#3D3D5A", TRAM: "#BB9944", METRO: "#7733BB" },
      tritanopia: { BUS: "#0073AC", "BUS:night": "#2A1A1A", TRAM: "#AC3355", METRO: "#55AC33" },
      highContrast: { BUS: "#0055FF", "BUS:night": "#FF5500", TRAM: "#FF8800", METRO: "#8800FF" },
    },
    dark: {
      universal: { BUS: "#5BA8D9", "BUS:night": "#7A7AAC", TRAM: "#8BD98B", METRO: "#FF8888" },
      deuteranopia: { BUS: "#66AAFF", "BUS:night": "#8888AA", TRAM: "#FFBB66", METRO: "#BB88FF" },
      protanopia: { BUS: "#5599DD", "BUS:night": "#7D7DAA", TRAM: "#DDBB77", METRO: "#AA77DD" },
      tritanopia: { BUS: "#33AADD", "BUS:night": "#6A3A3A", TRAM: "#DD6688", METRO: "#88DD66" },
      highContrast: { BUS: "#55AAFF", "BUS:night": "#FF8844", TRAM: "#FFAA44", METRO: "#AA44FF" },
    },
  },
  universalLimited: false,
};

beforeEach(() => {
  const settings = useSettingsStore.getState();
  settings.setAccessibilityScheme("none");
  // Clear ALL overrides (not just active city)
  useSettingsStore.setState({ modeColorOverrides: {} });
  // Reset stops
  useStopStore.setState({ stops: [], hydrated: true });
  // Reset color config
  useColorConfigStore.setState({ config: null, cityId: null, loading: false });
  // Reset to default city
  useCityStore.getState().setActiveCity(CITIES[0]);
});

describe("ColorSettings", () => {
  describe("collapsed/expanded toggle", () => {
    it("renders in collapsed state by default", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      expect(screen.getByTestId("color-settings-collapsed")).toBeDefined();
      expect(screen.queryByTestId("color-settings-expanded")).toBeNull();
    });

    it("shows scheme name in collapsed header", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      const collapsed = screen.getByTestId("color-settings-collapsed");
      expect(collapsed.textContent).toContain("None");
    });

    it("shows correct scheme name when changed", () => {
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      render(<ColorSettings />, { wrapper: Wrapper });
      const collapsed = screen.getByTestId("color-settings-collapsed");
      expect(collapsed.textContent).toContain("Deuteranopia");
    });

    it("expands when collapsed header is clicked", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("color-settings-expanded")).toBeDefined();
      expect(screen.queryByTestId("color-settings-collapsed")).toBeNull();
    });

    it("collapses when collapse button is clicked", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("color-settings-expanded")).toBeDefined();
      fireEvent.click(screen.getByTestId("color-settings-collapse-btn"));
      expect(screen.getByTestId("color-settings-collapsed")).toBeDefined();
    });

    it("shows chevron in collapsed state", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      expect(screen.getByTestId("chevron-expand")).toBeDefined();
    });

    it("shows chevron in expanded state", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("chevron-collapse")).toBeDefined();
    });
  });

  describe("GTFS-driven preview badges", () => {
    it("shows sub-mode preview badges when colorConfig is available", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("preview-default-BUS")).toBeDefined();
      expect(screen.getByTestId("preview-default-TRAM")).toBeDefined();
      expect(screen.getByTestId("preview-default-METRO")).toBeDefined();
    });

    it("shows header badges in collapsed state from colorConfig", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      // Header shows first 3 badges (sorted by routeCount: BUS=35, TRAM=10, BUS:night=5)
      expect(screen.getByTestId("header-badge-3G")).toBeDefined();
      expect(screen.getByTestId("header-badge-6N")).toBeDefined();
      expect(screen.getByTestId("header-badge-N1")).toBeDefined();
    });

    it("shows fallback when no colorConfig", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      expect(screen.getByTestId("header-no-data")).toBeDefined();
      expect(screen.getByTestId("header-no-data").textContent).toBe("No route data");
    });

    it("shows preview fallback when expanded with no colorConfig", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("preview-fallback")).toBeDefined();
    });

    it("shows 'Current' row when overrides exist", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      useSettingsStore.getState().setModeColorOverride("BUS", "#abcdef");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("preview-current-BUS")).toBeDefined();
    });

    it("shows 'Current' row when accessibility scheme is active (no overrides)", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("preview-current-BUS")).toBeDefined();
    });

    it("does not show 'Current' row when scheme is 'none' and no overrides", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.queryByTestId("preview-current-BUS")).toBeNull();
    });

    it("'Default' row ignores active scheme (shows untouched colors)", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      // Default row always rendered and is scheme-independent
      expect(screen.getByTestId("preview-default-BUS")).toBeDefined();
    });
  });

  describe("scheme selection", () => {
    it("renders all scheme radio options", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const radios = screen.getAllByRole("radio", { name: /./i });
      const schemeRadios = radios.filter(
        (r) => (r as HTMLInputElement).name === "a11y-scheme",
      );
      expect(schemeRadios).toHaveLength(6);
    });

    it("selects 'none' by default", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const noneRadio = screen.getAllByRole("radio").find(
        (r) => (r as HTMLInputElement).value === "none",
      ) as HTMLInputElement;
      expect(noneRadio.checked).toBe(true);
    });

    it("updates store when scheme is changed", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const deuteranopiaRadio = screen.getAllByRole("radio").find(
        (r) => (r as HTMLInputElement).value === "deuteranopia",
      ) as HTMLInputElement;
      fireEvent.click(deuteranopiaRadio);
      expect(useSettingsStore.getState().accessibilityScheme).toBe("deuteranopia");
    });

    it("shows high contrast toggle when CVD scheme selected", () => {
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("high-contrast-toggle")).toBeDefined();
    });

    it("hides high contrast toggle when scheme is none", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.queryByTestId("high-contrast-toggle")).toBeNull();
    });

    it("hides high contrast toggle when scheme is monochrome", () => {
      useSettingsStore.getState().setAccessibilityScheme("monochrome");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.queryByTestId("high-contrast-toggle")).toBeNull();
    });

    it("toggles highContrastEnabled in store", () => {
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const checkbox = screen.getByTestId("high-contrast-checkbox");
      fireEvent.click(checkbox);
      expect(useSettingsStore.getState().highContrastEnabled).toBe(true);
    });
  });

  describe("color picker (legacy fallback)", () => {
    it("updates store when color picker changes", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const picker = screen.getByTestId("color-picker-BUS");
      fireEvent.change(picker, { target: { value: "#ff00ff" } });
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({ vilnius: { BUS: "#ff00ff" } });
    });

    it("shows override indicator when mode has custom color", () => {
      useSettingsStore.getState().setModeColorOverride("TRAM", "#123456");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("override-indicator-TRAM")).toBeDefined();
    });

    it("does not show override indicator for non-customized modes", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.queryByTestId("override-indicator-BUS")).toBeNull();
    });

    it("write guard: removes override when picking default color", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff00ff");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const picker = screen.getByTestId("color-picker-BUS");
      // Pick the default BUS color
      fireEvent.change(picker, { target: { value: DEFAULT_MODE_COLORS.BUS } });
      const overrides = useSettingsStore.getState().modeColorOverrides;
      expect(overrides["vilnius"]?.BUS).toBeUndefined();
    });
  });

  describe("color picker (GTFS-driven)", () => {
    it("renders sub-mode color pickers when colorConfig available", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("color-picker-BUS")).toBeDefined();
      expect(screen.getByTestId("color-picker-BUS:night")).toBeDefined();
      expect(screen.getByTestId("color-picker-TRAM")).toBeDefined();
      expect(screen.getByTestId("color-picker-METRO")).toBeDefined();
    });

    it("updates store with sub-mode key when color changes", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const picker = screen.getByTestId("color-picker-BUS:night");
      fireEvent.change(picker, { target: { value: "#ff00ff" } });
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { "BUS:night": "#ff00ff" },
      });
    });
  });

  describe("reset controls", () => {
    it("shows reset-all button when overrides exist", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("reset-all-colors")).toBeDefined();
    });

    it("hides reset-all button when no overrides", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.queryByTestId("reset-all-colors")).toBeNull();
    });

    it("clears single override on per-mode reset", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      fireEvent.click(screen.getByTestId("reset-color-BUS"));
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({ vilnius: { TRAM: "#00ff00" } });
    });

    it("clears all overrides on reset-all", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      fireEvent.click(screen.getByTestId("reset-all-colors"));
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });
  });

  describe("mode filtering by city data (legacy fallback)", () => {
    it("shows only modes present in city stops when no colorConfig", () => {
      // Only BUS and TRAM in stops
      useStopStore.setState({
        stops: [
          {
            id: "s1",
            name: "Stop 1",
            location: { lat: 54.68, lon: 25.28 },
            lastSeen: Date.now(),
            lines: [
              { routeId: "r1", shortName: "3G", mode: "BUS" as const },
              { routeId: "r2", shortName: "6N", mode: "TRAM" as const },
            ],
          },
        ],
      });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      // BUS and TRAM pickers should exist
      expect(screen.getByTestId("color-picker-BUS")).toBeDefined();
      expect(screen.getByTestId("color-picker-TRAM")).toBeDefined();
      // METRO should not exist
      expect(screen.queryByTestId("color-picker-METRO")).toBeNull();
    });

    it("shows all modes as fallback when no stops and no colorConfig", () => {
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.getByTestId("color-picker-BUS")).toBeDefined();
      expect(screen.getByTestId("color-picker-METRO")).toBeDefined();
      expect(screen.getByTestId("color-picker-CAR")).toBeDefined();
    });
  });

  describe("grouped sub-mode display", () => {
    it("shows grouped sub-modes with parent mode headers", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      // Sub-mode pickers for BUS group
      expect(screen.getByTestId("color-picker-BUS")).toBeDefined();
      expect(screen.getByTestId("color-picker-BUS:night")).toBeDefined();
      // Sub-mode pickers for other modes
      expect(screen.getByTestId("color-picker-TRAM")).toBeDefined();
      expect(screen.getByTestId("color-picker-METRO")).toBeDefined();
    });

    it("does not show legacy mode list when colorConfig available", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      // Legacy fallback modes like CAR, WALK should not appear
      expect(screen.queryByTestId("color-picker-CAR")).toBeNull();
      expect(screen.queryByTestId("color-picker-WALK")).toBeNull();
    });

    it("no cross-city sync section", () => {
      useSettingsStore.setState({
        modeColorOverrides: {
          tricity: { BUS: "#abcdef" },
        },
      });
      render(<ColorSettings />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      expect(screen.queryByTestId("cross-city-sync")).toBeNull();
    });

    it("group headers use translated mode names", () => {
      useColorConfigStore.setState({ config: MOCK_COLOR_CONFIG, cityId: "vilnius" });
      const translatingT = (key: string, fallback?: string) => {
        if (key === "settings.mode_bus") return "AUTOBUS";
        if (key === "settings.mode_tram") return "TRAMWAJ";
        return fallback ?? key;
      };
      render(
        <I18nContext.Provider value={{ locale: "pl", formattingLocale: "pl", t: translatingT }}>
          <ColorSettings />
        </I18nContext.Provider>,
      );
      fireEvent.click(screen.getByTestId("color-settings-collapsed"));
      const expanded = screen.getByTestId("color-settings-expanded");
      expect(expanded.textContent).toContain("AUTOBUS");
      expect(expanded.textContent).toContain("TRAMWAJ");
    });
  });
});

describe("translatedSubModeLabel", () => {
  const base: SubModeEntry = {
    id: "BUS:0073ac",
    label: "Bus (blue)",
    parentMode: "BUS",
    color: "#0073AC",
    routeCount: 3,
    sampleRoutes: ["1"],
  };

  it("returns '<mode> (<color>)' when labelMode and labelColor are both set", () => {
    const sm: SubModeEntry = { ...base, labelMode: "BUS", labelColor: "blue" };
    const t = (key: string) => {
      if (key === "settings.mode_bus") return "Autobus";
      if (key === "color.blue") return "niebieski";
      return key;
    };
    expect(translatedSubModeLabel(sm, t)).toBe("Autobus (niebieski)");
  });

  it("returns translated mode only when labelColor is absent", () => {
    const sm: SubModeEntry = { ...base, labelMode: "BUS" };
    const t = (key: string, fallback?: string) => {
      if (key === "settings.mode_bus") return "Autobus";
      return fallback ?? key;
    };
    expect(translatedSubModeLabel(sm, t)).toBe("Autobus");
  });

  it("falls back to raw label when labelMode is absent", () => {
    const sm: SubModeEntry = { ...base };
    const t = (key: string, fallback?: string) => fallback ?? key;
    expect(translatedSubModeLabel(sm, t)).toBe("Bus (blue)");
  });

  it("handles TROLLEYBUS via lowercase key lookup", () => {
    const sm: SubModeEntry = { ...base, parentMode: "TROLLEYBUS", labelMode: "TROLLEYBUS", labelColor: "red" };
    const t = (key: string) => {
      if (key === "settings.mode_trolleybus") return "Тралейбус";
      if (key === "color.red") return "чырвоны";
      return key;
    };
    expect(translatedSubModeLabel(sm, t)).toBe("Тралейбус (чырвоны)");
  });

  it("uses labelMode as fallback when translation key is missing", () => {
    const sm: SubModeEntry = { ...base, labelMode: "FERRY", labelColor: "cyan" };
    const t = (_key: string, fallback?: string) => fallback ?? _key;
    expect(translatedSubModeLabel(sm, t)).toBe("FERRY (cyan)");
  });
});
