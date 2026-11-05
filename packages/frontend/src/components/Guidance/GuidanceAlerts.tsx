import { useCallback, useEffect, useRef, useState } from "react";
import type { Itinerary } from "@pt/shared";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useTranslation } from "../../i18n/index.ts";
import { useGetOffAlarm } from "../../hooks/useGetOffAlarm.ts";
import { useGuidanceDisplay } from "../../hooks/useGuidanceDisplay.ts";
import { useNextDepartureAfter } from "../../hooks/useNextDepartureAfter.ts";
import { notifyIfBackground } from "../../services/tripNotifications.ts";
import { GetOffAlarm } from "./GetOffAlarm.tsx";
import {
  DepartureReminderBanner,
  reminderCopy,
  type ReminderContext,
} from "./DepartureReminderBanner.tsx";
import {
  watchDeparture,
  type DepartureReminder,
  type ReminderWatch,
} from "./departureReminders.ts";

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration API unavailable or blocked — the banner still shows.
  }
}

/**
 * The banners that sit above the guidance step list — the departure
 * reminder before boarding, the get-off alarm on board — and the system
 * notifications behind them. Reads the guidance store itself so Home only has
 * to place it.
 */
export function GuidanceAlerts() {
  const { t, formattingLocale } = useTranslation();
  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const transitProgress = useGuidanceStore((s) => s.transitProgress);
  const getOffAlarmEnabled = useSettingsStore((s) => s.getOffAlarmEnabled);
  const notificationsEnabled = useSettingsStore((s) => s.tripNotificationsEnabled);
  const feedTz = useCityStore((s) => s.activeCity.tz);

  // "Your stop is next: X" — X is where the rider gets off, the current
  // leg's alighting stop, not the stop the vehicle is passing.
  const alightingStop = itinerary?.legs[currentLegIndex]?.to.name ?? null;
  const getOffAlarm = useGetOffAlarm(
    transitProgress?.stopsRemaining ?? null,
    alightingStop,
    phase,
    getOffAlarmEnabled,
    currentLegIndex,
  );

  // Departure reminders: watch the live display until the first ride is
  // boarded, and speak up on the transitions — leave time due, the bus moved,
  // a run needed, a miss.
  const { display, referenceNowMs } = useGuidanceDisplay();
  const firstRideIdx = itinerary ? itinerary.legs.findIndex((l) => l.mode !== "WALK") : -1;
  const firstRide = firstRideIdx >= 0 ? itinerary!.legs[firstRideIdx] : undefined;
  // A likely miss or a cancellation comes with the next bus of the same line
  // from the same stop.
  const nextDepartureMs = useNextDepartureAfter(
    firstRide,
    display?.catchStatus === "likely-miss" ||
      display?.catchStatus === "cancelled" ||
      display?.catchStatus === "removed"
      ? display.firstTransitDepartureMs
      : null,
  );
  const context: ReminderContext | null = firstRide
    ? {
        routeShortName: firstRide.routeShortName,
        mode: firstRide.mode,
        stopName: firstRide.from.name,
        formattingLocale,
        feedTz,
        nowMs: referenceNowMs,
      }
    : null;

  const watchRef = useRef<{ itinerary: Itinerary | null; watch: ReminderWatch | null }>({
    itinerary: null,
    watch: null,
  });
  const [reminder, setReminder] = useState<DepartureReminder | null>(null);
  const dismiss = useCallback(() => setReminder(null), []);

  useEffect(() => {
    if (watchRef.current.itinerary !== itinerary) {
      watchRef.current = { itinerary, watch: null };
      setReminder(null);
    }
    if (phase !== "navigating" || !display || !context || currentLegIndex > firstRideIdx) return;
    const next = watchDeparture(watchRef.current.watch, display, referenceNowMs);
    watchRef.current.watch = next.watch;
    if (!next.reminder) return;
    const reminder =
      (next.reminder.kind === "likely-miss" ||
        next.reminder.kind === "cancelled" ||
        next.reminder.kind === "removed") &&
      nextDepartureMs !== null
        ? { ...next.reminder, nextDepartureMs }
        : next.reminder;
    setReminder(reminder);
    const urgent =
      reminder.kind === "hurry" ||
      reminder.kind === "likely-miss" ||
      reminder.kind === "cancelled" ||
      reminder.kind === "removed";
    vibrate(urgent ? [200, 100, 200] : [150]);
    if (notificationsEnabled) {
      const { title, body } = reminderCopy(reminder, context, t);
      notifyIfBackground(title, body);
    }
    // `context` is rebuilt every render from the values listed here.
  }, [display, referenceNowMs, phase, itinerary, currentLegIndex, firstRideIdx, notificationsEnabled, t, formattingLocale, feedTz, nextDepartureMs]);

  return (
    <>
      {context && (
        <DepartureReminderBanner reminder={reminder} context={context} onDismiss={dismiss} />
      )}
      <GetOffAlarm alarm={getOffAlarm} />
    </>
  );
}
