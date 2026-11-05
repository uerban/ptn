import type { Leg } from "@pt/shared";
import { useTranslation } from "../../../i18n/index.ts";
import { useTripDelay } from "../../../stores/rtStore.ts";
import { type BadgeSize } from "../../../utils/appearance.ts";

interface Props {
  /** Realtime delay in seconds from `Leg.delaySeconds`. Undefined → schedule-only. */
  delaySeconds: number | undefined;
  compact?: boolean;
  size: BadgeSize;
}

/**
 * Surfaces realtime status for a transit leg. Delay is rounded to the
 * nearest minute before being bucketed:
 *   - undefined delaySeconds → dashed "scheduled" chip
 *   - rounded minutes === 0  → "on time" (|delay| < 30s)
 *   - rounded minutes >= 1   → "+Nm" (late)
 *   - rounded minutes <= -1  → "−Nm early"
 *
 * Visual treatment varies per `size`:
 *   - md : airy — colored text + pulsing dot, no chrome
 *   - lg : tinted background + 3px underline accent
 *   - sm : hard-bordered mono pill (dense)
 */
export function LiveBadge({ delaySeconds, compact = false, size }: Props) {
  const { t } = useTranslation();

  const schedule = typeof delaySeconds !== "number";
  const minutes = schedule ? 0 : Math.round(delaySeconds / 60);
  const tone: "sched" | "ok" | "late" | "early" = schedule
    ? "sched"
    : minutes >= 1
      ? "late"
      : minutes <= -1
        ? "early"
        : "ok";

  const label = schedule
    ? compact
      ? t("route.sched_short", "SCHED")
      : t("route.scheduled", "SCHEDULED")
    : tone === "ok"
      ? t("route.on_time", "ON TIME")
      : tone === "late"
        ? `+${minutes} ${t("time.min", "min")}`
        : `${Math.abs(minutes)} ${t("route.min_early", "min early")}`;

  const toneColorClass =
    tone === "ok"
      ? "text-success"
      : tone === "late"
        ? "text-warning"
        : tone === "early"
          ? "text-accent"
          : "text-fg-muted";

  // Dot / dashed marker shared across all variants
  const Marker = () =>
    schedule ? (
      <span
        aria-hidden
        className="inline-block w-1.5 h-1.5 rounded-full border border-dashed border-current"
      />
    ) : (
      <span
        aria-hidden
        className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse"
      />
    );

  // md: airy — colored text + pulsing dot, NO chrome
  if (size === "md") {
    return (
      <span
        className={`inline-flex items-center gap-1 font-mono font-bold tracking-wider tabular-nums
          ${toneColorClass}
          ${compact ? "text-[9px]" : "text-[10px]"}`}
        title={schedule ? scheduledTitle(t) : liveTitle(t)}
      >
        <Marker />
        {label}
      </span>
    );
  }

  // lg: tinted background + 3px underline accent, no ring
  if (size === "lg") {
    const bgClass =
      tone === "ok"
        ? "bg-success/10"
        : tone === "late"
          ? "bg-warning/10"
          : tone === "early"
            ? "bg-accent/10"
            : "bg-surface-overlay";
    const underlineStyle: React.CSSProperties = {
      borderBottom: "3px solid currentColor",
      borderRadius: 4,
    };
    return (
      <span
        className={`inline-flex items-center gap-1 font-mono font-bold tracking-wider tabular-nums
          ${toneColorClass} ${bgClass}
          ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]"}`}
        style={underlineStyle}
        title={schedule ? scheduledTitle(t) : liveTitle(t)}
      >
        <Marker />
        {label}
      </span>
    );
  }

  // sm: hard-bordered mono pill (dense)
  if (size === "sm") {
    const borderClass = schedule
      ? "border-dashed border-divider"
      : tone === "ok"
        ? "border-success/60 bg-success/10"
        : tone === "late"
          ? "border-warning/60 bg-warning/10"
          : "border-accent/60 bg-accent/10";
    return (
      <span
        className={`inline-flex items-center gap-1 rounded border font-mono font-bold tracking-wider tabular-nums
          ${borderClass} ${toneColorClass}
          ${compact ? "px-1 py-px text-[9px]" : "px-1.5 py-0.5 text-[10px]"}`}
        title={schedule ? scheduledTitle(t) : liveTitle(t)}
      >
        <Marker />
        {label}
      </span>
    );
  }

  // If size gains a new literal we fail to compile:
  const _exhaustive: never = size;
  throw new Error(`LiveBadge: unreachable size ${_exhaustive as string}`);
}

function scheduledTitle(t: (k: string, f?: string) => string): string {
  return t(
    "route.scheduled_desc",
    "Schedule-based estimate — no live feed for this vehicle",
  );
}

function liveTitle(t: (k: string, f?: string) => string): string {
  return t("route.live", "Live real-time data");
}

/**
 * A ride's LiveBadge from the freshest delay there is: the live RT store when
 * it holds the trip (the result list keeps each first ride's route polled),
 * else the leg's own `delaySeconds`. A cancelled trip reads "Cancelled", as
 * on the departure boards. Renders nothing for a leg with neither, like the
 * inline guard it replaces.
 */
export function LiveLegBadge({ leg, compact = false, size }: { leg: Leg; compact?: boolean; size: BadgeSize }) {
  const { t } = useTranslation();
  const live = useTripDelay(leg.tripId);
  // DELETED: no badge at all — it is not to be shown as cancelled.
  if (live?.deleted) return null;
  if (live?.cancelled) {
    return (
      <span className="text-[10px] font-semibold text-danger line-through">
        {t("popup.cancelled", "Cancelled")}
      </span>
    );
  }
  const delaySeconds = live ? live.delaySeconds : leg.delaySeconds;
  if (typeof delaySeconds !== "number") return null;
  return <LiveBadge delaySeconds={delaySeconds} compact={compact} size={size} />;
}
