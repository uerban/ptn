import type { TransportMode } from "@pt/shared";
import { contrastTextColor, resolveRouteStyle } from "../../../utils/routeColor.ts";
import { useSettingsStore } from "../../../stores/settingsStore.ts";
import { useCityStore } from "../../../stores/cityStore.ts";
import { useColorConfigStore } from "../../../stores/colorConfigStore.ts";
import { useTranslation } from "../../../i18n/index.ts";
import { modeLabel } from "../../../utils/modeLabels.ts";
import { ModeGlyph } from "../../ModeGlyph.tsx";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

type Size = "sm" | "md" | "lg";

interface Props {
  mode: TransportMode;
  /** Route short name (e.g., "3G", "M1"). Falls back to the mode pictogram/glyph. */
  label?: string;
  /** Route color in hex from GTFS (if present, overrides palette lookup). */
  routeColor?: string;
  size?: Size;
}

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-5 min-w-[1.5rem] px-1.5 text-[11px]",
  md: "h-7 min-w-[1.75rem] px-2 text-xs",
  lg: "h-9 min-w-[2.25rem] px-2.5 text-sm",
};

/**
 * Colored pill with the route short name. Color resolves via the same
 * pipeline as TransportModeIcon — respects GTFS feed color, palette
 * overrides, accessibility scheme, and high-contrast toggle.
 *
 * Falls back to the mode's pictogram — or its localized letter glyph, for a
 * mode with no pictogram — when no label is supplied.
 */
export function LineBadge({ mode, label, routeColor, size = "md" }: Props) {
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides =
    useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const { t } = useTranslation();

  // A route short name comes from the feed and is never translated; the
  // no-short-name fallback is the mode's pictogram or localized glyph.
  const modeName = modeLabel(t, mode);
  const glyph = <ModeGlyph mode={mode} />;

  // Feed color (if present) wins — it's authored by the agency.
  if (routeColor && routeColor.trim() !== "") {
    const bg = routeColor.startsWith("#") ? routeColor : `#${routeColor}`;
    return (
      <span
        data-testid="route-badge"
        className={`inline-flex items-center justify-center rounded font-bold shrink-0 tabular-nums ${SIZE_CLASS[size]}`}
        style={{ background: bg, color: contrastTextColor(bg) }}
        title={modeName}
        aria-label={modeName}
      >
        {label ?? glyph}
      </span>
    );
  }

  const rs = resolveRouteStyle(
    undefined,
    mode,
    modeOverrides,
    scheme,
    theme,
    undefined,
    highContrastEnabled,
    colorConfig,
  );
  return (
    <span
      data-testid="route-badge"
      className={`inline-flex items-center justify-center rounded font-bold shrink-0 tabular-nums ${SIZE_CLASS[size]}`}
      style={
        {
          "--route-color": rs.background,
          background: rs.background,
          color: rs.color,
          ...(rs.textStroke && { WebkitTextStroke: rs.textStroke }),
          ...(rs.paintOrder && { paintOrder: rs.paintOrder }),
        } as React.CSSProperties
      }
      title={modeName}
      aria-label={modeName}
    >
      {label ?? glyph}
    </span>
  );
}
