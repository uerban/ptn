import type { CSSProperties } from "react";
import type { TransportMode } from "@pt/shared";
import { resolveRouteStyle } from "../utils/routeColor.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useColorConfigStore } from "../stores/colorConfigStore.ts";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

interface DepartureLineBadgeProps {
  /** The route short name, from the feed (never translated). */
  label: string;
  mode: TransportMode;
  subMode?: string;
  /** GTFS `route_color`, with or without `#`. */
  routeColor?: string;
  /** Size and shape only: the colours are resolved here. */
  className: string;
  "data-testid"?: string;
}

/**
 * A departure's line badge, coloured the way the departure surfaces colour a
 * line (stop popup, departure sheet): through `resolveRouteStyle`, so the
 * rider's per-mode colour overrides and an accessibility palette come before
 * the feed's route colour. The map strip's pill and the trip sheet it opens
 * both draw this one, so a line keeps its colour across the tap. (`LineBadge`,
 * the route-results badge, lets the feed colour win instead.)
 */
export function DepartureLineBadge({
  label,
  mode,
  subMode,
  routeColor,
  className,
  "data-testid": testId,
}: DepartureLineBadgeProps) {
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const style = resolveRouteStyle(
    routeColor, mode, modeOverrides, scheme, theme,
    subMode, highContrastEnabled, colorConfig,
  );
  return (
    <span
      data-testid={testId}
      className={className}
      style={{
        background: style.background,
        color: style.color,
        ...(style.textStroke && { WebkitTextStroke: style.textStroke }),
        ...(style.paintOrder && { paintOrder: style.paintOrder }),
      } as CSSProperties}
    >
      {label}
    </span>
  );
}
