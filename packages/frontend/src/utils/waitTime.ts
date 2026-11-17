/**
 * Waits of an hour or more read as h:mm ("1:05") unless the rider asked for
 * minutes only. Under an hour the caller keeps its own "N min" wording.
 */
export function waitClock(minutes: number, minutesOnly: boolean): string | null {
  if (minutesOnly || minutes < 60) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** "1 hour 5 minutes", in the formatting locale, for screen readers. */
export function waitSpoken(minutes: number, locale: string): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const unit = (n: number, u: "hour" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "long" }).format(n);
  return m === 0 ? unit(h, "hour") : `${unit(h, "hour")} ${unit(m, "minute")}`;
}
