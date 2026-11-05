import { useEffect } from "react";
import type { TransportMode } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { modeLabel } from "../../utils/modeLabels.ts";
import { formatTime } from "../RouteResults/shared/format.ts";
import { Icon } from "../Icon.tsx";
import type { DepartureReminder } from "./departureReminders.ts";

const AUTO_DISMISS_MS = 15_000;

type Translate = (key: string, fallback?: string) => string;

export interface ReminderContext {
  /** The first ride's line: short name, else the mode. */
  routeShortName?: string;
  mode: TransportMode;
  /** Where the first ride is boarded. */
  stopName: string;
  formattingLocale: string;
  /** Feed tz for the times; device tz when omitted. */
  feedTz?: string;
  nowMs: number;
}

/** Title and body of a reminder — shared by the banner and the system notification. */
export function reminderCopy(
  r: DepartureReminder,
  ctx: ReminderContext,
  t: Translate,
): { title: string; body: string } {
  const line = ctx.routeShortName ?? modeLabel(t, ctx.mode);
  const time = formatTime(new Date(r.departureMs).toISOString(), ctx.formattingLocale, ctx.feedTz);
  const fill = (s: string) =>
    s.replace("{line}", line).replace("{stop}", ctx.stopName).replace("{time}", time);
  switch (r.kind) {
    case "leave":
      return {
        title: t("notif.leave_title", "Time to leave"),
        body: fill(t("notif.leave_body", "{line} leaves {stop} at {time}")),
      };
    case "hurry":
      return {
        title: fill(t("notif.hurry_title", "Hurry to catch {line}")),
        body: fill(t("notif.hurry_body", "Walk fast or run — it leaves {stop} at {time}")),
      };
    case "likely-miss":
      return {
        title: fill(t("notif.miss_title", "You'll likely miss {line}")),
        body: fill(
          r.nextDepartureMs !== undefined
            ? t("notif.miss_body_next", "It leaves {stop} at {time} · next at {next}").replace(
                "{next}",
                formatTime(new Date(r.nextDepartureMs).toISOString(), ctx.formattingLocale, ctx.feedTz),
              )
            : t("notif.miss_body", "It leaves {stop} at {time}"),
        ),
      };
    case "cancelled":
    case "removed":
      return {
        title: fill(
          r.kind === "removed"
            ? t("notif.removed_title", "{line} is no longer scheduled")
            : t("notif.cancelled_title", "{line} is cancelled"),
        ),
        body: fill(
          r.nextDepartureMs !== undefined
            ? t("notif.cancelled_body_next", "Next from {stop} at {next}").replace(
                "{next}",
                formatTime(new Date(r.nextDepartureMs).toISOString(), ctx.formattingLocale, ctx.feedTz),
              )
            : t("notif.cancelled_body", "Look for another way from {stop}"),
        ),
      };
    case "earlier":
    case "later": {
      const title = (
        r.kind === "earlier"
          ? t("notif.earlier_title", "{line} now leaves {n} min earlier")
          : t("notif.later_title", "{line} now leaves {n} min later")
      ).replace("{n}", String(r.movedMinutes ?? 0));
      const body =
        r.leaveMs <= ctx.nowMs
          ? t("notif.moved_body_leave_now", "It leaves {stop} at {time} · leave now")
          : t("notif.moved_body_leave_at", "It leaves {stop} at {time} · leave at {leave}").replace(
              "{leave}",
              formatTime(new Date(r.leaveMs).toISOString(), ctx.formattingLocale, ctx.feedTz),
            );
      return { title: fill(title), body: fill(body) };
    }
  }
}

const TONE: Record<DepartureReminder["kind"], string> = {
  leave: "bg-surface-raised text-fg border border-divider",
  later: "bg-surface-raised text-fg border border-divider",
  earlier: "bg-amber-400/95 text-amber-950",
  hurry: "bg-amber-400/95 text-amber-950",
  "likely-miss": "bg-danger text-white",
  cancelled: "bg-danger text-white",
  // Neutral: a DELETED trip is not to be shown as cancelled.
  removed: "bg-surface-raised text-fg border border-divider",
};

interface Props {
  reminder: DepartureReminder | null;
  context: ReminderContext;
  onDismiss: () => void;
}

/**
 * On-screen twin of the departure reminder notification, above the step
 * list: the moment the leave time comes, the bus moves, or the catch turns
 * into a run or a miss. Auto-dismisses; `role="alert"` announces it.
 */
export function DepartureReminderBanner({ reminder, context, onDismiss }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!reminder) return;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [reminder, onDismiss]);

  if (!reminder) return null;
  const { title, body } = reminderCopy(reminder, context, t);
  return (
    <div
      role="alert"
      data-testid="departure-reminder"
      className={`mx-3 mb-2 px-4 py-3 rounded-xl shadow-2 flex items-center gap-3 ${TONE[reminder.kind]}`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs opacity-90">{body}</div>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-full hover:bg-black/10"
        aria-label={t("notif.dismiss", "Dismiss")}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
