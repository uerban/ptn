import type { Itinerary, TransportMode } from "@pt/shared";
import { useSettingsStore } from "../../../stores/settingsStore.ts";
import { useCityStore } from "../../../stores/cityStore.ts";
import { useColorConfigStore } from "../../../stores/colorConfigStore.ts";
import { resolveRouteColor } from "../../../utils/routeColor.ts";
import { toSegments, type Segment } from "./legHelpers.ts";
import { useTranslation } from "../../../i18n/index.ts";
import { modeLabel } from "../../../utils/modeLabels.ts";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

interface Props {
  itinerary: Itinerary;
  /**
   * Pre-computed segments (e.g. from `deriveItineraryDisplay`). When supplied,
   * `toSegments(itinerary)` is skipped — cards thread the helper's segments
   * through to avoid an extra pass per render.
   */
  segments?: Segment[];
  /** Playhead in [0, 1] over itinerary.durationSeconds. Null/undefined/NaN/Infinity hide the cursor. */
  progress?: number | null;
  /** Bar height in px. Default 12. */
  height?: number;
  /** Minimum segment width % for tiny walks/waits. Default 4. */
  minSegmentPct?: number;
  /**
   * When true, the bar is hidden from the accessibility tree. Cards set this
   * when a sibling `LeaveHint` already announces the wait, to prevent screen
   * readers from reading the same fact twice.
   */
  ariaHidden?: boolean;
}

export function ItineraryBar({
  itinerary,
  segments: providedSegments,
  progress,
  height = 12,
  minSegmentPct = 4,
  ariaHidden,
}: Props) {
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const { t } = useTranslation();

  const segments = providedSegments ?? toSegments(itinerary);
  const segMinutes = (s: Segment): number =>
    s.kind === "buffer-wait" ? Math.round(s.seconds / 60) : s.minutes;
  const totalMin = segments.reduce((sum, seg) => sum + segMinutes(seg), 0) || 1;
  const raw = segments.map((s) => (segMinutes(s) / totalMin) * 100);
  const floored = raw.map((w) => Math.max(w, minSegmentPct));
  const scale = 100 / floored.reduce((s, w) => s + w, 0);
  const widths = floored.map((w) => w * scale);

  const stripeColor = theme === "dark" ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.6)";
  const walkStripe = theme === "dark" ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.35)";

  const showProgress = typeof progress === "number" && Number.isFinite(progress);
  const clampedProgress = showProgress ? Math.max(0, Math.min(1, progress as number)) : 0;

  return (
    <div
      data-testid="itinerary-bar"
      className="relative w-full flex rounded-full overflow-hidden bg-surface-overlay border border-divider"
      style={{ height }}
      role="img"
      aria-label={describe(segments, t)}
      aria-hidden={ariaHidden ? true : undefined}
    >
      {segments.map((seg, i) => {
        const w = widths[i];
        let bg: string;
        if (seg.kind === "ride") {
          bg = resolveRouteColor(seg.leg.routeColor, seg.leg.mode, modeOverrides, scheme, theme, undefined, highContrastEnabled, colorConfig);
        } else if (seg.kind === "walk") {
          if (seg.transferWalk) {
            bg = "repeating-linear-gradient(-45deg, var(--color-fg-muted) 0 2px, transparent 2px 6px)";
          } else {
            const walkColor = resolveRouteColor(undefined, "WALK", modeOverrides, scheme, theme, undefined, highContrastEnabled, colorConfig);
            bg = `repeating-linear-gradient(45deg, ${walkColor} 0 4px, ${stripeColor} 4px 8px)`;
          }
        } else if (seg.kind === "wait") {
          const base = seg.tight ? "var(--color-danger)" : walkStripe;
          bg = `repeating-linear-gradient(90deg, ${base} 0 1px, transparent 1px 4px)`;
        } else {
          // buffer-wait: rendered like a non-tight wait
          bg = `repeating-linear-gradient(90deg, ${walkStripe} 0 1px, transparent 1px 4px)`;
        }
        return (
          <div
            key={i}
            data-testid="itinerary-bar-segment"
            style={{ width: `${w}%`, background: bg }}
            className="h-full border-l border-surface first:border-0"
            title={segmentTitle(seg, t)}
          />
        );
      })}
      {showProgress && (
        <div
          data-testid="itinerary-bar-progress"
          className="absolute top-0 h-full w-0.5 bg-fg shadow-sm transition-[left] duration-1000"
          style={{ left: `${clampedProgress * 100}%` }}
        />
      )}
    </div>
  );
}

type Translate = (key: string, fallback?: string) => string;

// The bar is the only announcement a screen reader gets for the shape of an
// itinerary, so its label and per-segment titles are translated like any other
// copy — they were English on every locale before.
function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{${k}}`).join(String(v)),
    template,
  );
}

function rideName(seg: Extract<Segment, { kind: "ride" }>, t: Translate): string {
  return seg.leg.routeShortName ?? modeLabel(t, seg.leg.mode);
}

function describe(segs: Segment[], t: Translate): string {
  return segs
    .map((s) => {
      switch (s.kind) {
        case "ride":
          return fill(t("route.bar_ride", "{line} {n} min"), {
            line: rideName(s, t),
            n: s.minutes,
          });
        case "walk":
          return fill(
            s.transferWalk
              ? t("route.bar_transfer_walk", "transfer walk {n} min")
              : t("route.bar_walk", "walk {n} min"),
            { n: s.minutes },
          );
        case "wait":
          return fill(
            s.tight
              ? t("route.bar_wait_tight", "wait {n} min (tight)")
              : t("route.bar_wait", "wait {n} min"),
            { n: s.minutes },
          );
        case "buffer-wait":
          return fill(t("route.bar_wait_at", "wait {n} min at {stop}"), {
            n: Math.round(s.seconds / 60),
            stop: s.atStopName,
          });
        default: {
          const _exhaustive: never = s;
          return _exhaustive;
        }
      }
    })
    .join(", ");
}

function segmentTitle(seg: Segment, t: Translate): string {
  switch (seg.kind) {
    case "ride":
      return fill(t("route.bar_ride_title", "{line} — {n} min"), {
        line: rideName(seg, t),
        n: seg.minutes,
      });
    case "walk":
      return fill(
        seg.transferWalk
          ? t("route.bar_transfer_walk_title", "Transfer walk · {n} min · {m} m")
          : t("route.bar_walk_title", "Walk · {n} min · {m} m"),
        { n: seg.minutes, m: seg.meters },
      );
    case "wait":
      return fill(
        seg.tight
          ? t("route.bar_wait_title_tight", "Wait {n} min at {stop} (tight)")
          : t("route.bar_wait_title", "Wait {n} min at {stop}"),
        { n: seg.minutes, stop: seg.atStopName },
      );
    case "buffer-wait":
      return fill(
        t("route.bar_buffer_title", "Pre-stop wait · {n} min at {stop}"),
        { n: Math.round(seg.seconds / 60), stop: seg.atStopName },
      );
    default: {
      const _exhaustive: never = seg;
      return _exhaustive;
    }
  }
}
