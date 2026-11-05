import { useState, useMemo } from "react";
import type { TransportMode, SubModeEntry } from "@pt/shared";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useColorConfigStore } from "../../stores/colorConfigStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useStopStore } from "../../stores/stopStore.ts";
import { useTranslation } from "../../i18n/index.ts";
import {
  type AccessibilityScheme,
  resolveRouteColor,
  resolveRouteStyle,
  contrastTextColor,
} from "../../utils/routeColor.ts";
import { MODE_CONFIG } from "../TransportModeIcon.tsx";
import { ModeGlyph } from "../ModeGlyph.tsx";

const SCHEME_OPTIONS: {
  value: AccessibilityScheme;
  labelKey: string;
  labelFallback: string;
  descKey: string;
  descFallback: string;
}[] = [
  {
    value: "none",
    labelKey: "settings.scheme_none",
    labelFallback: "None",
    descKey: "settings.scheme_none_desc",
    descFallback: "Default colors",
  },
  {
    value: "universal",
    labelKey: "settings.scheme_universal",
    labelFallback: "Universal",
    descKey: "settings.scheme_universal_desc",
    descFallback: "Optimized for all vision types",
  },
  {
    value: "deuteranopia",
    labelKey: "settings.scheme_deuteranopia",
    labelFallback: "Deuteranopia",
    descKey: "settings.scheme_deuteranopia_desc",
    descFallback: "Red-green (common)",
  },
  {
    value: "protanopia",
    labelKey: "settings.scheme_protanopia",
    labelFallback: "Protanopia",
    descKey: "settings.scheme_protanopia_desc",
    descFallback: "Red-green (red weak)",
  },
  {
    value: "tritanopia",
    labelKey: "settings.scheme_tritanopia",
    labelFallback: "Tritanopia",
    descKey: "settings.scheme_tritanopia_desc",
    descFallback: "Blue-yellow",
  },
  {
    value: "monochrome",
    labelKey: "settings.scheme_monochrome",
    labelFallback: "Monochrome",
    descKey: "settings.scheme_monochrome_desc",
    descFallback: "Grayscale only",
  },
];

const ALL_DISPLAY_MODES: { mode: TransportMode; labelKey: string; labelFallback: string }[] = [
  { mode: "BUS", labelKey: "settings.mode_bus", labelFallback: "Bus" },
  { mode: "TRAM", labelKey: "settings.mode_tram", labelFallback: "Tram" },
  { mode: "TROLLEYBUS", labelKey: "settings.mode_trolleybus", labelFallback: "Trolleybus" },
  { mode: "METRO", labelKey: "settings.mode_metro", labelFallback: "Metro" },
  { mode: "RAIL", labelKey: "settings.mode_rail", labelFallback: "Rail" },
  { mode: "FERRY", labelKey: "settings.mode_ferry", labelFallback: "Ferry" },
  { mode: "CABLE_TRAM", labelKey: "settings.mode_cable_tram", labelFallback: "Cable Tram" },
  { mode: "AERIAL", labelKey: "settings.mode_aerial", labelFallback: "Aerial" },
  { mode: "OTHER", labelKey: "settings.mode_other", labelFallback: "Other" },
  { mode: "FUNICULAR", labelKey: "settings.mode_funicular", labelFallback: "Funicular" },
  { mode: "WALK", labelKey: "settings.mode_walk", labelFallback: "Walk" },
  { mode: "BIKE", labelKey: "settings.mode_bike", labelFallback: "Bike" },
  { mode: "BIKE_SHARE", labelKey: "settings.mode_bike_share", labelFallback: "Bike Share" },
  { mode: "SCOOTER", labelKey: "settings.mode_scooter", labelFallback: "Scooter" },
  { mode: "CAR", labelKey: "settings.mode_car", labelFallback: "Car" },
];

const EMPTY_OVERRIDES: Record<string, string> = {};

const MODE_LABELS: Record<string, string> = {
  BUS: "Bus", TRAM: "Tram", TROLLEYBUS: "Trolleybus", METRO: "Metro", RAIL: "Rail",
  FERRY: "Ferry", CABLE_TRAM: "Cable Tram", AERIAL: "Aerial", OTHER: "Other",
  FUNICULAR: "Funicular",
  WALK: "Walk", BIKE: "Bike", BIKE_SHARE: "Bike Share",
  SCOOTER: "Scooter", CAR: "Car",
};

/** Get the scheme display name from SCHEME_OPTIONS */
function getSchemeName(scheme: AccessibilityScheme, t: (key: string, fallback: string) => string): string {
  const opt = SCHEME_OPTIONS.find((o) => o.value === scheme);
  return opt ? t(opt.labelKey, opt.labelFallback) : scheme;
}

/** Build translated sub-mode label from structured fields; fall back to raw label. */
export function translatedSubModeLabel(
  subMode: SubModeEntry,
  t: (key: string, fallback?: string) => string,
): string {
  if (subMode.labelMode) {
    const mode = t(`settings.mode_${subMode.labelMode.toLowerCase()}`, subMode.labelMode);
    if (subMode.labelColor) {
      const color = t(`color.${subMode.labelColor}`, subMode.labelColor);
      return `${mode} (${color})`;
    }
    return mode;
  }
  return subMode.label;
}

function SubModeRow({
  subMode,
  isOverridden,
  currentColor,
  onChangeColor,
  onReset,
  isLast,
}: {
  subMode: SubModeEntry;
  isOverridden: boolean;
  currentColor: string;
  onChangeColor: (color: string) => void;
  onReset: () => void;
  isLast: boolean;
}) {
  const { t } = useTranslation();
  const modeStyle = {
    background: currentColor,
    color: contrastTextColor(currentColor),
  };
  const displayLabel = translatedSubModeLabel(subMode, t);

  return (
    <div
      className={`flex items-center justify-between px-4 py-3 ${isLast ? "" : "border-b border-divider"}`}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-flex items-center justify-center w-7 h-7 rounded text-xs font-bold shrink-0"
          style={modeStyle}
        >
          {MODE_CONFIG[subMode.parentMode]?.icon ?? subMode.parentMode[0]}
        </span>
        <div className="flex flex-col">
          <span className="text-sm text-fg">{displayLabel}</span>
          {subMode.sampleRoutes.length > 0 && (
            <span className="text-[10px] text-fg-muted">
              {subMode.sampleRoutes.join(", ")} ({subMode.routeCount} routes)
            </span>
          )}
        </div>
        {isOverridden && (
          <span
            className="w-2 h-2 rounded-full bg-accent shrink-0"
            title="Customized"
            data-testid={`override-indicator-${subMode.id}`}
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="relative w-8 h-8 rounded-lg overflow-hidden cursor-pointer border border-divider">
          <input
            type="color"
            value={currentColor}
            onChange={(e) => onChangeColor(e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label={displayLabel + " color"}
            data-testid={`color-picker-${subMode.id}`}
          />
          <span
            className="block w-full h-full"
            style={{ backgroundColor: currentColor }}
          />
        </label>
        {isOverridden && (
          <button
            onClick={onReset}
            className="text-xs text-fg-muted hover:text-fg"
            title="Reset"
            aria-label={`Reset ${displayLabel}`}
            data-testid={`reset-color-${subMode.id}`}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

export function ColorSettings() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const setHighContrastEnabled = useSettingsStore((s) => s.setHighContrastEnabled);
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const setScheme = useSettingsStore((s) => s.setAccessibilityScheme);
  const setOverride = useSettingsStore((s) => s.setModeColorOverride);
  const removeOverride = useSettingsStore((s) => s.removeModeColorOverride);
  const resetOverrides = useSettingsStore((s) => s.resetModeColorOverrides);
  const stops = useStopStore((s) => s.stops);

  // Color config from backend (GTFS-driven)
  const colorConfig = useColorConfigStore((s) => s.config);

  // Group sub-modes by parentMode (when colorConfig available)
  const groupedModes = useMemo(() => {
    if (!colorConfig) return [];
    const groups = new Map<string, SubModeEntry[]>();
    for (const mode of colorConfig.modes) {
      const list = groups.get(mode.parentMode) ?? [];
      list.push(mode);
      groups.set(mode.parentMode, list);
    }
    return Array.from(groups.entries());
  }, [colorConfig]);

  // Fallback: filter display modes to only those present in city data
  const cityModes = useMemo(() => {
    const modes = new Set<TransportMode>();
    for (const stop of stops) {
      if (!stop.lines) continue;
      for (const line of stop.lines) modes.add(line.mode);
    }
    return modes;
  }, [stops]);

  const displayModes = useMemo(
    () => cityModes.size > 0
      ? ALL_DISPLAY_MODES.filter((d) => cityModes.has(d.mode))
      : ALL_DISPLAY_MODES,
    [cityModes],
  );

  // Preview badges from color-config (one per sub-mode, sorted by routeCount)
  const previewBadges = useMemo(() => {
    if (!colorConfig) return [];
    return colorConfig.modes
      .slice()
      .sort((a, b) => b.routeCount - a.routeCount)
      .slice(0, 8);
  }, [colorConfig]);

  const moreCount = colorConfig ? Math.max(0, colorConfig.modes.length - 8) : 0;

  const hasOverrides = Object.keys(modeOverrides).length > 0;

  const handleColorChange = (subModeId: string, color: string) => {
    const entry = colorConfig?.modes.find((m) => m.id === subModeId);
    const parentMode = (entry?.parentMode ?? "BUS") as TransportMode;
    const defaultColor = colorConfig
      ? resolveRouteColor(undefined, parentMode, {}, scheme, theme, subModeId, highContrastEnabled, colorConfig)
      : resolveRouteColor(undefined, subModeId as TransportMode, {}, scheme, theme);
    if (color.toLowerCase() === defaultColor.toLowerCase()) {
      removeOverride(subModeId);
    } else {
      setOverride(subModeId, color);
    }
  };

  const handleLegacyColorChange = (mode: TransportMode, color: string) => {
    const defaultColor = resolveRouteColor(undefined, mode, {}, scheme, theme);
    if (color.toLowerCase() === defaultColor.toLowerCase()) {
      removeOverride(mode);
    } else {
      setOverride(mode, color);
    }
  };

  // Collapsed header badges: first 3 sub-modes from color-config, or legacy stop badges
  const headerBadges = useMemo(() => {
    if (previewBadges.length > 0) return previewBadges.slice(0, 3);
    return [];
  }, [previewBadges]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-between px-4 py-3
          bg-surface-raised rounded-xl border border-divider text-left"
        data-testid="color-settings-collapsed"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-fg">
            {t("settings.color_accessibility", "Color & Accessibility")}
          </span>
          <span className="text-xs text-fg-muted">
            {getSchemeName(scheme, t)}
          </span>
          <div className="flex items-center gap-1">
            {headerBadges.length > 0 ? (
              headerBadges.map((sm) => {
                const color = resolveRouteColor(
                  sm.color, sm.parentMode, modeOverrides, scheme, theme,
                  sm.id, highContrastEnabled, colorConfig,
                );
                const style = { background: color, color: contrastTextColor(color) };
                const badgeText = sm.sampleRoutes[0] ?? sm.label.split(" ")[0];
                return (
                  <span
                    key={sm.id}
                    className="inline-flex items-center justify-center w-8 h-6 rounded text-xs font-bold"
                    style={style}
                    data-testid={`header-badge-${badgeText}`}
                  >
                    {badgeText}
                  </span>
                );
              })
            ) : (
              <span className="text-xs text-fg-muted" data-testid="header-no-data">
                {t("settings.no_route_data", "No route data")}
              </span>
            )}
          </div>
        </div>
        <span className="text-fg-muted" data-testid="chevron-expand">▸</span>
      </button>
    );
  }

  return (
    <div className="space-y-6" data-testid="color-settings-expanded">
      {/* Collapse button */}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex items-center gap-2 text-sm font-semibold text-fg-muted uppercase tracking-wider"
        data-testid="color-settings-collapse-btn"
      >
        <span data-testid="chevron-collapse">▾</span>
        {t("settings.color_accessibility", "Color & Accessibility")}
      </button>

      {/* Accessibility Scheme */}
      <section>
        <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
          {t("settings.color_scheme", "Color Scheme")}
        </h2>
        <div className="bg-surface-raised rounded-xl border border-divider">
          {SCHEME_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center justify-between px-4 py-3
                border-b border-divider last:border-b-0 cursor-pointer"
            >
              <div className="flex flex-col">
                <span className="text-sm text-fg">
                  {t(opt.labelKey, opt.labelFallback)}
                </span>
                <span className="text-xs text-fg-muted">
                  {t(opt.descKey, opt.descFallback)}
                </span>
              </div>
              <input
                type="radio"
                name="a11y-scheme"
                value={opt.value}
                checked={scheme === opt.value}
                onChange={() => setScheme(opt.value)}
                className="accent-accent"
              />
            </label>
          ))}
        </div>

        {/* High contrast toggle (appears when a CVD scheme is selected) */}
        {scheme !== "none" && scheme !== "monochrome" && (
          <label className="flex items-center gap-2 text-sm text-fg-secondary mt-2" data-testid="high-contrast-toggle">
            <input
              type="checkbox"
              checked={highContrastEnabled}
              onChange={(e) => setHighContrastEnabled(e.target.checked)}
              data-testid="high-contrast-checkbox"
            />
            {t("settings.high_contrast", "High contrast (aggressive color remap)")}
          </label>
        )}

        {/* Universal limited warning — palette collapsed to near-identical shades
            under all three CVD simulations; resolver auto-falls back to the
            high-contrast palette so colors stay distinguishable. */}
        {colorConfig?.universalLimited && scheme === "universal" && (
          <p className="text-xs text-warning mt-1" data-testid="universal-limited-warning">
            {t("settings.universal_limited", "Universal palette collapses on this city — showing high-contrast colors instead. Pick your specific condition for a minimal-shift palette tuned to it.")}
          </p>
        )}

        {/* Preview strip — "Default" row always shows the untouched palette
            (feed colors or cluster centroids, scheme="none", no overrides);
            "Current" row only shows when any adjustment is active and renders
            the actual color the user would see live. */}
        <div className="mt-3" data-testid="color-preview-strip">
          {previewBadges.length > 0 ? (
            <div className="space-y-1 mb-4">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-fg-muted w-12">
                  {t("settings.preview_default", "Default")}
                </span>
                <div className="flex gap-1.5 flex-wrap">
                  {previewBadges.map((sm) => {
                    const color = resolveRouteColor(
                      sm.color, sm.parentMode, EMPTY_OVERRIDES, "none", theme,
                      sm.id, false, colorConfig,
                    );
                    const style = { background: color, color: contrastTextColor(color) };
                    const badgeText = sm.sampleRoutes[0] ?? sm.label.split(" ")[0];
                    return (
                      <span
                        key={sm.id}
                        className="text-xs font-bold px-2 py-0.5 rounded"
                        style={style}
                        data-testid={`preview-default-${sm.id}`}
                      >
                        {badgeText}
                      </span>
                    );
                  })}
                  {moreCount > 0 && <span className="text-xs text-fg-muted">+{moreCount}</span>}
                </div>
              </div>
              {(scheme !== "none" || highContrastEnabled || hasOverrides) && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-fg-muted w-12">
                    {t("settings.preview_current", "Current")}
                  </span>
                  <div className="flex gap-1.5 flex-wrap">
                    {previewBadges.map((sm) => {
                      const color = resolveRouteColor(
                        sm.color, sm.parentMode, modeOverrides, scheme, theme,
                        sm.id, highContrastEnabled, colorConfig,
                      );
                      const style = { background: color, color: contrastTextColor(color) };
                      const badgeText = sm.sampleRoutes[0] ?? sm.label.split(" ")[0];
                      return (
                        <span
                          key={sm.id}
                          className="text-xs font-bold px-2 py-0.5 rounded"
                          style={style}
                          data-testid={`preview-current-${sm.id}`}
                        >
                          {badgeText}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-muted">
                {t("settings.preview", "Preview")}:
              </span>
              <span className="text-xs text-fg-muted" data-testid="preview-fallback">
                {t("settings.no_route_data", "No route data")}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Mode Colors */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider">
            {t("settings.mode_colors", "Mode Colors")}
          </h2>
          {hasOverrides && (
            <button
              onClick={resetOverrides}
              className="text-xs text-accent hover:underline"
              data-testid="reset-all-colors"
            >
              {t("settings.reset_all", "Reset all")}
            </button>
          )}
        </div>

        {/* GTFS-driven grouped sub-mode list (when colorConfig available) */}
        {colorConfig && groupedModes.map(([parentMode, subModes]) => (
          <div key={parentMode}>
            <div className="text-[10px] uppercase tracking-wider text-fg-muted ml-1 mb-1">
              {t(`settings.mode_${parentMode.toLowerCase()}`, MODE_LABELS[parentMode] ?? parentMode)}
            </div>
            <div className="bg-surface-overlay rounded-lg border border-divider overflow-hidden mb-3">
              {subModes.map((sm, idx) => (
                <SubModeRow
                  key={sm.id}
                  subMode={sm}
                  isOverridden={!!modeOverrides[sm.id]}
                  currentColor={resolveRouteColor(
                    sm.color, sm.parentMode, modeOverrides, scheme, theme,
                    sm.id, highContrastEnabled, colorConfig,
                  )}
                  onChangeColor={(color) => handleColorChange(sm.id, color)}
                  onReset={() => removeOverride(sm.id)}
                  isLast={idx === subModes.length - 1}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Legacy fallback mode list (when colorConfig unavailable) */}
        {!colorConfig && (
          <div className="bg-surface-raised rounded-xl border border-divider">
            {displayModes.map(({ mode, labelKey, labelFallback }) => {
              const resolved = resolveRouteColor(undefined, mode, modeOverrides, scheme, theme);
              const modeStyle = resolveRouteStyle(undefined, mode, modeOverrides, scheme, theme);
              const hasOverride = mode in modeOverrides;

              return (
                <div
                  key={mode}
                  className="flex items-center justify-between px-4 py-3
                    border-b border-divider last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-flex items-center justify-center w-7 h-7 rounded text-xs font-bold shrink-0"
                      style={{
                        "--route-color": resolved,
                        background: modeStyle.background,
                        color: modeStyle.color,
                        ...(modeStyle.textStroke && { WebkitTextStroke: modeStyle.textStroke }),
                        ...(modeStyle.paintOrder && { paintOrder: modeStyle.paintOrder }),
                      } as React.CSSProperties}
                    >
                      <ModeGlyph mode={mode} />
                    </span>
                    <span className="text-sm text-fg">
                      {t(labelKey, labelFallback)}
                    </span>
                    {hasOverride && (
                      <span
                        className="w-2 h-2 rounded-full bg-accent shrink-0"
                        title={t("settings.customized", "Customized")}
                        data-testid={`override-indicator-${mode}`}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="relative w-8 h-8 rounded-lg overflow-hidden cursor-pointer border border-divider">
                      <input
                        type="color"
                        value={resolved}
                        onChange={(e) => handleLegacyColorChange(mode, e.target.value)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        aria-label={t(labelKey, labelFallback) + " color"}
                        data-testid={`color-picker-${mode}`}
                      />
                      <span
                        className="block w-full h-full"
                        style={{ backgroundColor: resolved }}
                      />
                    </label>
                    {hasOverride && (
                      <button
                        onClick={() => removeOverride(mode)}
                        className="text-xs text-fg-muted hover:text-fg"
                        title={t("settings.reset", "Reset")}
                        aria-label={t("settings.reset", "Reset") + " " + t(labelKey, labelFallback)}
                        data-testid={`reset-color-${mode}`}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
