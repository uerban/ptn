/** Formatted time-of-day (HH:MM) for an ISO timestamp, in `tz` when supplied
 *  (the feed/agency tz); otherwise the device tz (local-user path). */
export function formatTime(iso: string, locale: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Minutes (rounded) from a seconds value. */
export function toMinutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}
