import { useTranslation } from "../../../i18n/index.ts";
import { formatTime } from "./format.ts";
import type { CatchStatus } from "./itineraryDisplay.ts";

interface Props {
  bufferSeconds: number;
  leadingWaitSeconds: number;
  recommendedDepartureMs: number;
  /** Feed/agency tz for the leave time; device tz when omitted (local-user path). */
  feedTz?: string;
  /** `display.catchStatus`. Anything short of on-time replaces the buffer hint. */
  catchStatus?: CatchStatus | null;
  /** Likely miss / cancelled: minutes until the same line next leaves the stop, when known. */
  nextDepartureInMin?: number | null;
}

/**
 * Inline hint rendered below a route card's time row, when there's a
 * pre-stop buffer — or a catch problem — to communicate. Returns null when no
 * hint is needed (on time, and `bufferSeconds === 0` or rounded buffer is
 * < 1 minute) — call sites need not guard.
 *
 * A catch problem wins over the buffer, whatever the buffer setting — it is
 * the difference between making the departure and not:
 *   - tight: `Leave now · no time to spare at the stop`
 *   - hurry: `Leave now and hurry · walk fast or run to make it`
 *   - likely-miss: `You'll likely miss this departure`, with
 *     `· next in ~{n} min` when the same line's next departure is known
 *   - cancelled: `This departure is cancelled`, with the same `· next in`
 *   - removed (DELETED): `No longer scheduled`, with the same `· next in` —
 *     neutral, never worded as a cancellation
 *
 * On time, two variants:
 *   - `Leave now · {n} min wait at stop` when leadingWait is 0
 *   - `Leave HH:MM · {n} min wait at stop` when leadingWait > 0
 */
export function LeaveHint({
  bufferSeconds,
  leadingWaitSeconds,
  recommendedDepartureMs,
  feedTz,
  catchStatus,
  nextDepartureInMin,
}: Props) {
  const { t, formattingLocale } = useTranslation();
  if (catchStatus === "departed") return null;
  if (catchStatus === "tight") {
    return (
      <div className="text-xs text-fg font-medium leading-snug">
        {t("route.leave_now_tight", "Leave now · no time to spare at the stop")}
      </div>
    );
  }
  if (catchStatus === "hurry") {
    return (
      <div className="text-xs text-warning font-medium leading-snug">
        {t("route.leave_hurry", "Leave now and hurry · walk fast or run to make it")}
      </div>
    );
  }
  if (catchStatus === "cancelled") {
    return (
      <div className="text-xs text-danger font-medium leading-snug">
        {typeof nextDepartureInMin === "number"
          ? t(
              "route.cancelled_next",
              "This departure is cancelled · next in ~{n} min",
            ).replace("{n}", String(nextDepartureInMin))
          : t("route.cancelled", "This departure is cancelled")}
      </div>
    );
  }
  if (catchStatus === "removed") {
    // Neutral on purpose: a DELETED trip is "not shown as cancelled to
    // riders" (GTFS-RT), typically because substitute service replaces it.
    return (
      <div className="text-xs text-fg font-medium leading-snug">
        {typeof nextDepartureInMin === "number"
          ? t("route.removed_next", "No longer scheduled · next in ~{n} min").replace(
              "{n}",
              String(nextDepartureInMin),
            )
          : t("route.removed", "No longer scheduled")}
      </div>
    );
  }
  if (catchStatus === "likely-miss") {
    return (
      <div className="text-xs text-danger font-medium leading-snug">
        {typeof nextDepartureInMin === "number"
          ? t(
              "route.likely_miss_next",
              "You'll likely miss this departure · next in ~{n} min",
            ).replace("{n}", String(nextDepartureInMin))
          : t("route.likely_miss", "You'll likely miss this departure")}
      </div>
    );
  }
  if (bufferSeconds <= 0) return null;
  const bufferMin = Math.round(bufferSeconds / 60);
  if (bufferMin === 0) return null;

  if (leadingWaitSeconds === 0) {
    return (
      <div className="text-xs text-fg-muted leading-snug">
        {t("route.leave_now_with_wait", "Leave now · {n} min wait at stop").replace(
          "{n}",
          String(bufferMin),
        )}
      </div>
    );
  }

  const leaveTime = formatTime(
    new Date(recommendedDepartureMs).toISOString(),
    formattingLocale,
    feedTz,
  );
  return (
    <div className="text-xs text-fg-muted leading-snug">
      {t("route.leave_at_with_wait", "Leave {time} · {n} min wait at stop")
        .replace("{time}", leaveTime)
        .replace("{n}", String(bufferMin))}
    </div>
  );
}
