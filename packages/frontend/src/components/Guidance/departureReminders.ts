import type {
  CatchStatus,
  ItineraryDisplay,
} from "../RouteResults/shared/itineraryDisplay.ts";

/**
 * What the rider is told before the first ride:
 *   - leave: the leave time has come.
 *   - hurry: walking no longer makes it, a run still does.
 *   - likely-miss: nothing makes it any more.
 *   - earlier / later: live data moved the bus since the rider was last told.
 *   - cancelled: live data says the bus is not running.
 *   - removed: live data DELETED the bus — said as "no longer scheduled".
 */
export type DepartureReminderKind =
  | "leave"
  | "hurry"
  | "likely-miss"
  | "earlier"
  | "later"
  | "cancelled"
  | "removed";

export interface DepartureReminder {
  kind: DepartureReminderKind;
  /** The first ride's (live) departure. */
  departureMs: number;
  /** When to set off; at or before now means "now". */
  leaveMs: number;
  /** earlier / later: whole minutes the departure moved. */
  movedMinutes?: number;
  /** likely-miss / cancelled / removed: when the same line next leaves the stop, if known. */
  nextDepartureMs?: number;
}

/** What the watcher carries from one clock tick to the next. */
export interface ReminderWatch {
  status: CatchStatus;
  leaveDue: boolean;
  /** The departure the rider was last told about. */
  announcedDepartureMs: number;
  /** One-shot reminders already given. */
  fired: ReadonlyArray<"leave" | "hurry" | "likely-miss" | "cancelled" | "removed">;
}

/** Live data moving the bus by less than this is not worth interrupting for. */
const MOVE_THRESHOLD_MS = 60_000;

/**
 * One observation of the guided display. Returns the updated watch and the
 * reminder this tick earns, if any — at most one, the most urgent.
 *
 * Reminders are transitions, never states: opening guidance on a bus that is
 * already a hurry says nothing, because the screen already does. The first
 * observation only sets the baseline.
 */
export function watchDeparture(
  prev: ReminderWatch | null,
  display: ItineraryDisplay,
  nowMs: number,
): { watch: ReminderWatch | null; reminder: DepartureReminder | null } {
  const status = display.catchStatus;
  if (!status || status === "departed" || display.parseFailed) {
    return { watch: prev, reminder: null };
  }
  const departureMs = display.firstTransitDepartureMs;
  const leaveMs = display.recommendedDepartureMs;
  const leaveDue = leaveMs <= nowMs;
  const catchable = status === "on-time" || status === "tight";

  if (!prev) {
    const fired: ReminderWatch["fired"] = [
      ...(status === "hurry" ||
      status === "likely-miss" ||
      status === "cancelled" ||
      status === "removed"
        ? [status]
        : []),
      ...(leaveDue ? (["leave"] as const) : []),
    ];
    return { watch: { status, leaveDue, announcedDepartureMs: departureMs, fired }, reminder: null };
  }

  // A cancelled or removed bus is the whole story: nothing else about it is
  // worth saying.
  if (status === "cancelled" || status === "removed") {
    const first = !prev.fired.includes(status);
    return {
      watch: {
        ...prev,
        status,
        fired: first ? [...prev.fired, status] : prev.fired,
      },
      reminder: first ? { kind: status, departureMs, leaveMs } : null,
    };
  }

  const moved = departureMs - prev.announcedDepartureMs;
  let reminder: DepartureReminder | null = null;
  if (status === "likely-miss" && !prev.fired.includes("likely-miss")) {
    reminder = { kind: "likely-miss", departureMs, leaveMs };
  } else if (status === "hurry" && !prev.fired.includes("hurry")) {
    reminder = { kind: "hurry", departureMs, leaveMs };
  } else if (Math.abs(moved) >= MOVE_THRESHOLD_MS) {
    reminder = {
      kind: moved < 0 ? "earlier" : "later",
      departureMs,
      leaveMs,
      movedMinutes: Math.round(Math.abs(moved) / 60_000),
    };
  } else if (catchable && leaveDue && !prev.leaveDue && !prev.fired.includes("leave")) {
    reminder = { kind: "leave", departureMs, leaveMs };
  }

  const fired = new Set(prev.fired);
  if (reminder?.kind === "hurry" || reminder?.kind === "likely-miss") fired.add(reminder.kind);
  // Every reminder names the time to go, so a due leave time has been said.
  if (reminder && leaveDue) fired.add("leave");

  return {
    watch: {
      status,
      leaveDue,
      announcedDepartureMs: reminder ? departureMs : prev.announcedDepartureMs,
      fired: [...fired],
    },
    reminder,
  };
}
