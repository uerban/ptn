import type { TransportMode } from "@pt/shared";
import { resolveRouteStyle } from "../utils/routeColor.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useColorConfigStore } from "../stores/colorConfigStore.ts";
import { useTranslation } from "../i18n/index.ts";
import { modeLabel, MODE_CONFIG } from "../utils/modeLabels.ts";
import { ModeGlyph } from "./ModeGlyph.tsx";

// Re-exported from its original home: the table itself now lives next to
// the label/glyph lookups so `modeLabels.ts` need not import this file.
export { MODE_CONFIG };

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};


interface Props {
  mode: TransportMode;
  size?: "sm" | "md";
}

export function TransportModeIcon({ mode, size = "sm" }: Props) {
  const { t } = useTranslation();
  const label = modeLabel(t, mode);
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const px = size === "sm" ? "w-5 h-5 text-[10px]" : "w-7 h-7 text-xs";
  const rs = resolveRouteStyle(undefined, mode, modeOverrides, scheme, theme, undefined, highContrastEnabled, colorConfig);

  return (
    <span
      className={`${px} rounded flex items-center justify-center font-bold shrink-0`}
      style={{
        '--route-color': rs.background,
        background: rs.background,
        color: rs.color,
        ...(rs.textStroke && { WebkitTextStroke: rs.textStroke }),
        ...(rs.paintOrder && { paintOrder: rs.paintOrder }),
      } as React.CSSProperties}
      title={label}
      aria-label={label}
    >
      <ModeGlyph mode={mode} />
    </span>
  );
}
