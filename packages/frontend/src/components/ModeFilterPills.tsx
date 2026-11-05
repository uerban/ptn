import type { TransportMode } from "@pt/shared";
import { useTranslation } from "../i18n/index.ts";
import { MODE_CONFIG } from "./TransportModeIcon.tsx";
import { resolveRouteStyle } from "../utils/routeColor.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useColorConfigStore } from "../stores/colorConfigStore.ts";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

/** Stable ordering so pills don't jump around between renders. */
const MODE_ORDER: TransportMode[] = [
  "TRAM", "TROLLEYBUS", "BUS", "METRO", "RAIL", "FERRY",
  "CABLE_TRAM", "AERIAL", "FUNICULAR", "OTHER",
];

interface ModeFilterPillsProps {
  /** The set of unique modes present in the departure list. */
  modes: TransportMode[];
  /** Currently selected mode filter, or null for "All". */
  activeMode: TransportMode | null;
  /** Called when the user taps a pill. null means "All". */
  onChange: (mode: TransportMode | null) => void;
}

export function ModeFilterPills({ modes, activeMode, onChange }: ModeFilterPillsProps) {
  const { t } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);

  // Only render when 2+ modes are present
  if (modes.length < 2) return null;

  // Sort modes in a stable order
  const sorted = [...modes].sort((a, b) => {
    const ai = MODE_ORDER.indexOf(a);
    const bi = MODE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return 1;
    return ai - bi;
  });

  return (
    <div
      data-testid="mode-filter-pills"
      className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto"
      role="tablist"
      aria-label={t("filter.mode_filter", "Filter by transport mode")}
    >
      {/* "All" pill */}
      <button
        role="tab"
        aria-selected={activeMode === null}
        data-testid="mode-pill-all"
        onClick={() => onChange(null)}
        className={`text-xs font-semibold px-2.5 py-1 rounded-full border whitespace-nowrap transition-colors ${
          activeMode === null
            ? "bg-accent text-on-accent border-accent"
            : "bg-surface-overlay text-fg-muted border-divider hover:bg-surface-overlay/80"
        }`}
      >
        {t("filter.all", "All")}
      </button>

      {sorted.map((mode) => {
        const isActive = activeMode === mode;
        const config = MODE_CONFIG[mode] ?? MODE_CONFIG.BUS;
        const style = resolveRouteStyle(undefined, mode, modeOverrides, scheme, theme, undefined, highContrastEnabled, colorConfig);

        return (
          <button
            key={mode}
            role="tab"
            aria-selected={isActive}
            data-testid={`mode-pill-${mode}`}
            onClick={() => onChange(isActive ? null : mode)}
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border whitespace-nowrap transition-colors ${
              isActive
                ? "border-transparent"
                : "bg-surface-overlay text-fg-muted border-divider hover:bg-surface-overlay/80"
            }`}
            style={
              isActive
                ? { background: style.background, color: style.color }
                : undefined
            }
          >
            {config.label}
          </button>
        );
      })}
    </div>
  );
}
