import { memo } from "react";
import type { LineInfo, TransportMode } from "@pt/shared";
import { resolveRouteStyle } from "../../utils/routeColor.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useColorConfigStore } from "../../stores/colorConfigStore.ts";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

interface StopMarkerProps {
  name: string;
  lines?: LineInfo[];
  offset: { dx: number; dy: number };
}

const MAX_BADGES_PER_ROW = 6;

/** Dimension-affecting classes shared with TransitMap's hidden measurement DOM. */
export const STOP_CARD_BODY_CLASS =
  "bg-surface-raised rounded-lg shadow-1 px-2.5 py-1.5 border border-divider max-w-[180px] min-w-[44px] min-h-[44px] flex flex-col justify-center";
export const STOP_CARD_NAME_CLASS = "text-xs font-semibold text-fg truncate mb-0.5";
export const STOP_CARD_LINES_CLASS = "flex flex-col gap-0.5";
export const STOP_CARD_ROW_CLASS = "flex gap-0.5";
export const STOP_CARD_BADGE_CLASS =
  "text-[10px] font-bold px-1 py-px rounded leading-tight text-center whitespace-nowrap";

/** Split badges into balanced rows, max 6 per row */
export function splitBadgeRows(lines: LineInfo[]): LineInfo[][] {
  const n = lines.length;
  if (n <= MAX_BADGES_PER_ROW) return [lines];
  const numRows = Math.ceil(n / MAX_BADGES_PER_ROW);
  const perRow = Math.ceil(n / numRows);
  const rows: LineInfo[][] = [];
  for (let i = 0; i < n; i += perRow) {
    rows.push(lines.slice(i, i + perRow));
  }
  return rows;
}

/**
 * Station card shown at zoom 15+ as a MapLibre HTML Marker.
 * The marker wrapper is anchored at the stop's dot position.
 * The card floats at `offset` pixels from center, connected by a dashed SVG line.
 */
function StopMarkerImpl({ name, lines, offset }: StopMarkerProps) {
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const { dx, dy } = offset;

  // Anchor the card at its nearest edge to the dot so it extends AWAY from
  // the dot, never back over it.
  const tx = dx > 0 ? "0%" : dx < 0 ? "-100%" : "-50%";
  const ty = dy > 0 ? "0%" : dy < 0 ? "-100%" : "-50%";

  return (
    <div className="relative" style={{ width: 0, height: 0 }}>
      {/* Connecting line SVG — from dot (0,0) to offset point (dx, dy) */}
      <svg
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        <line
          x1={0}
          y1={0}
          x2={dx}
          y2={dy}
          stroke="var(--connector-line)"
          strokeWidth={1.5}
          strokeDasharray="4,3"
          opacity={0.7}
        />
        <circle cx={dx} cy={dy} r={2.5} fill="var(--connector-line)" opacity={0.7} />
      </svg>

      {/* Card */}
      {/*
 * `min-w-[44px]` / `min-h-[44px]` enforce the iOS HIG / Material Design Accessibility 44x44pt
 * tap-target floor on the click target. Visual design (`px-2.5 py-1.5`, badge layout) is
 * unchanged: a single-character stop with no badges previously rendered as a ~24x24 box, well
 * under the touch threshold. The floor is on the click target itself (not a separate overlay)
 * so focus rings and hover styles stay attached to the visible surface. `flex flex-col
 * justify-center` centers the short-name label vertically when the floor expands the box past
 * its natural height.
 */}
      {/*
        `cursor-pointer` is on this inner card AND on the outer
        `.stop-marker-container` (set in TransitMap). The actual click
        handler is on the outer for identity stability across React
        re-renders; this class is a visual cursor cue and the selector
        used by the 44px-tap-target unit test.
      */}
      <div
        className={`absolute cursor-pointer hover:shadow-2 transition-shadow ${STOP_CARD_BODY_CLASS}`}
        style={{
          left: dx,
          top: dy,
          transform: `translate(${tx}, ${ty})`,
        }}
      >
        <div className={STOP_CARD_NAME_CLASS}>
          {name}
        </div>
        {lines && lines.length > 0 && (
          <div className={STOP_CARD_LINES_CLASS}>
            {splitBadgeRows(lines).map((row, ri) => (
              <div key={ri} className={STOP_CARD_ROW_CLASS}>
                {row.map((line) => {
                  const rs = resolveRouteStyle(line.color, line.mode, modeOverrides, scheme, theme, line.subMode, highContrastEnabled, colorConfig);
                  return (
                    <span
                      key={line.routeId}
                      className={STOP_CARD_BADGE_CLASS}
                      style={{
                        '--route-color': rs.background,
                        background: rs.background,
                        color: rs.color,
                        ...(rs.textStroke && { WebkitTextStroke: rs.textStroke }),
                        ...(rs.paintOrder && { paintOrder: rs.paintOrder }),
                      } as React.CSSProperties}
                    >
                      {line.shortName}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Memoized so the debounced re-render in TransitMap only updates the inner
// DOM when stop content actually changes. The click target lives on the
// outer `.stop-marker-container`, so memoization is purely a perf concern;
// stability is already handled at the outer layer.
export const StopMarker = memo(StopMarkerImpl);
