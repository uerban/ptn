export interface WaitUnits {
  hour: string;
  minute: string;
}

const DEFAULT_UNITS: WaitUnits = { hour: "h", minute: "min" };

/**
 * Waits of an hour or more read as "1 h 9 min" unless the rider asked for
 * minutes only. A clock-like "1:09" next to "57 min" read as a time of day.
 * Under an hour the caller keeps its own "N min" wording.
 */
export function waitClock(minutes: number, minutesOnly: boolean, units: WaitUnits = DEFAULT_UNITS): string | null {
  if (minutesOnly || minutes < 60) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}\u00a0${units.hour}` : `${h}\u00a0${units.hour} ${m}\u00a0${units.minute}`;
}

/** "1 hour 5 minutes", in the formatting locale, for screen readers. */
export function waitSpoken(minutes: number, locale: string): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const unit = (n: number, u: "hour" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "long" }).format(n);
  return m === 0 ? unit(h, "hour") : `${unit(h, "hour")} ${unit(m, "minute")}`;
}
