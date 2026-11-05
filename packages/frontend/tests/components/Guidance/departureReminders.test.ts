import { describe, it, expect } from "vitest";
import { watchDeparture, type ReminderWatch } from "../../../src/components/Guidance/departureReminders.ts";
import type { ItineraryDisplay } from "../../../src/components/RouteResults/shared/itineraryDisplay.ts";

const T = (hhmmss: string) => Date.parse(`2026-09-25T${hhmmss}Z`);

/** Only the fields the watcher reads. */
function display(over: Partial<ItineraryDisplay>): ItineraryDisplay {
  return {
    recommendedDepartureMs: T("17:34:00"),
    firstTransitDepartureMs: T("17:41:00"),
    bufferSeconds: 180,
    leadingWaitSeconds: 0,
    segments: [],
    legs: [],
    bufferClamped: false,
    alreadyDeparted: false,
    parseFailed: false,
    catchStatus: "on-time",
    ...over,
  };
}

/** Run a sequence of (display, now) observations; collect the reminders. */
function run(steps: Array<[Partial<ItineraryDisplay>, string]>) {
  let watch: ReminderWatch | null = null;
  const out: Array<string | null> = [];
  for (const [d, now] of steps) {
    const r = watchDeparture(watch, display(d), T(now));
    watch = r.watch;
    out.push(r.reminder ? `${r.reminder.kind}${r.reminder.movedMinutes ? `:${r.reminder.movedMinutes}` : ""}` : null);
  }
  return out;
}

describe("watchDeparture", () => {
  it("says nothing on opening — the screen already shows the state", () => {
    expect(run([[{ catchStatus: "hurry" }, "17:39:00"]])).toEqual([null]);
  });

  it("reminds once when the leave time comes due", () => {
    expect(
      run([
        [{}, "17:30:00"],
        [{}, "17:33:59"],
        [{}, "17:34:00"],
        [{}, "17:34:30"],
      ]),
    ).toEqual([null, null, "leave", null]);
  });

  it("does not call a leave time already past on opening a reminder", () => {
    expect(run([[{}, "17:35:00"], [{}, "17:35:10"]])).toEqual([null, null]);
  });

  it("warns when only a run still makes it, and when nothing does — once each", () => {
    expect(
      run([
        [{}, "17:30:00"],
        [{ catchStatus: "hurry" }, "17:38:00"],
        [{ catchStatus: "hurry" }, "17:38:10"],
        [{ catchStatus: "likely-miss" }, "17:39:30"],
        [{ catchStatus: "likely-miss" }, "17:39:40"],
      ]),
    ).toEqual([null, "hurry", null, "likely-miss", null]);
  });

  it("tells the rider when live data moves the bus, earlier or later", () => {
    expect(
      run([
        [{}, "17:30:00"],
        [{ firstTransitDepartureMs: T("17:40:30"), recommendedDepartureMs: T("17:33:30") }, "17:30:10"],
        [{ firstTransitDepartureMs: T("17:39:00"), recommendedDepartureMs: T("17:32:00") }, "17:30:20"],
        [{ firstTransitDepartureMs: T("17:44:00"), recommendedDepartureMs: T("17:37:00") }, "17:30:30"],
      ]),
    ).toEqual([null, null, "earlier:2", "later:5"]);
  });

  it("goes quiet once the bus has left", () => {
    expect(
      run([
        [{}, "17:30:00"],
        [{ catchStatus: "departed", alreadyDeparted: true, firstTransitDepartureMs: T("17:39:00") }, "17:41:00"],
      ]),
    ).toEqual([null, null]);
  });
});

describe("watchDeparture — cancellation", () => {
  it("tells the rider once when the bus is cancelled, and nothing else after", () => {
    expect(
      run([
        [{}, "17:30:00"],
        [{ catchStatus: "cancelled" }, "17:31:00"],
        [{ catchStatus: "cancelled" }, "17:34:00"],
        [{ catchStatus: "cancelled", firstTransitDepartureMs: T("17:45:00") }, "17:35:00"],
      ]),
    ).toEqual([null, "cancelled", null, null]);
  });
});

describe("watchDeparture — removed (DELETED)", () => {
  it("tells the rider once that the bus is no longer scheduled, then nothing else", () => {
    expect(
      run([
        [{}, "17:30:00"],
        [{ catchStatus: "removed" }, "17:31:00"],
        [{ catchStatus: "removed" }, "17:34:00"],
      ]),
    ).toEqual([null, "removed", null]);
  });
});
