/**
 * Local selection of service alerts: which alerts concern what is on screen,
 * whether they are active, and which translation to show.
 *
 * Alerts are fetched city-wide, so the request never says which stop, line or
 * trip the user is looking at. Everything here runs on the device.
 */
import type {
  Alert,
  AlertActivePeriod,
  AlertInformedEntity,
  AlertText,
  AlertTranslation,
} from "@pt/shared";
import { serviceDayToUnix } from "@pt/shared/time";

// ─── Selector matching ──────────────────────────────────────────────────────

/**
 * What a surface shows, in the same terms as an alert selector: a stop sheet
 * knows its stop (and, per departure row, the route, trip and direction); a
 * line view knows its route; a journey leg knows route, trip and stops.
 */
export type AlertTarget = AlertInformedEntity;

/**
 * How an alert relates to a target:
 * - `direct`: some selector matches on every field it names;
 * - `partial`: some selector agrees on every field the target knows, but names
 *   a field the target does not (route X at stop Y, seen from line X's view);
 * - `null`: no selector concerns the target.
 */
export type AlertMatch = "direct" | "partial" | null;

const SELECTOR_FIELDS = [
  "agencyId",
  "routeId",
  "routeType",
  "directionId",
  "tripId",
  "stopId",
] as const satisfies readonly (keyof AlertInformedEntity)[];

/** Match one selector. Fields within a selector are ANDed. */
export function matchSelector(
  selector: AlertInformedEntity,
  target: AlertTarget,
): AlertMatch {
  let named = 0;
  let unknown = 0;
  for (const field of SELECTOR_FIELDS) {
    const wanted = selector[field];
    if (wanted === undefined) continue;
    named += 1;
    const actual = target[field];
    if (actual === undefined) {
      unknown += 1;
      continue;
    }
    if (actual !== wanted) return null;
  }
  // A selector naming nothing would match everything; the contract forbids
  // it, so treat it as matching nothing.
  if (named === 0) return null;
  // Nothing the target knows was compared: no evidence it concerns the target.
  if (unknown === named) return null;
  return unknown === 0 ? "direct" : "partial";
}

/** Match an alert. Its selectors are ORed; the strongest match wins. */
export function matchAlert(alert: Alert, target: AlertTarget): AlertMatch {
  let best: AlertMatch = null;
  for (const selector of alert.informedEntities) {
    const match = matchSelector(selector, target);
    if (match === "direct") return "direct";
    if (match === "partial") best = "partial";
  }
  return best;
}

export interface AlertSelectionOptions {
  /** Include alerts that only partially match (default false). */
  includePartial?: boolean;
  /** Only alerts active at this instant (epoch ms). */
  activeAt?: number;
}

/**
 * Alerts concerning any of `targets`, in response order, each listed once.
 */
export function selectAlerts(
  alerts: readonly Alert[],
  targets: readonly AlertTarget[],
  options: AlertSelectionOptions = {},
): Alert[] {
  const { includePartial = false, activeAt } = options;
  return alerts.filter((alert) => {
    if (activeAt !== undefined && !isAlertActiveAt(alert, activeAt)) return false;
    return targets.some((target) => {
      const match = matchAlert(alert, target);
      return match === "direct" || (includePartial && match === "partial");
    });
  });
}

// ─── Active periods ─────────────────────────────────────────────────────────

/** Parse an ISO instant; an absent or unreadable bound is open-ended. */
function parseInstant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function periodBounds(period: AlertActivePeriod): [number, number] {
  return [
    parseInstant(period.start) ?? Number.NEGATIVE_INFINITY,
    parseInstant(period.end) ?? Number.POSITIVE_INFINITY,
  ];
}

/**
 * True when any active period overlaps `[fromMs, toMs)`. An alert without
 * active periods is always active. Period ends are inclusive, as in GTFS-RT.
 */
export function isAlertActiveDuring(
  alert: Alert,
  fromMs: number,
  toMs: number,
): boolean {
  if (alert.activePeriods.length === 0) return true;
  return alert.activePeriods.some((period) => {
    const [start, end] = periodBounds(period);
    return start < toMs && end >= fromMs;
  });
}

/** True when the alert is active at the instant `atMs`. */
export function isAlertActiveAt(alert: Alert, atMs: number): boolean {
  if (alert.activePeriods.length === 0) return true;
  return alert.activePeriods.some((period) => {
    const [start, end] = periodBounds(period);
    return start <= atMs && atMs <= end;
  });
}

function addDays(ymd: number, days: number): number {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor((ymd % 10000) / 100);
  const d = ymd % 100;
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return (
    date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
  );
}

/**
 * Bounds of the civil day `ymd` (YYYYMMDD) in the city's time zone, as epoch
 * ms `[start, end)`. On DST transition dates the day is 23 or 25 hours long.
 */
export function cityDayBounds(ymd: number, tz: string): [number, number] {
  return [
    serviceDayToUnix(ymd, 0, tz) * 1000,
    serviceDayToUnix(addDays(ymd, 1), 0, tz) * 1000,
  ];
}

/**
 * True when the alert is active at any time during the civil day `ymd` in the
 * city's time zone `tz`, whatever the device's own time zone.
 */
export function isAlertActiveOnCityDay(
  alert: Alert,
  ymd: number,
  tz: string,
): boolean {
  const [start, end] = cityDayBounds(ymd, tz);
  return isAlertActiveDuring(alert, start, end);
}

// ─── Translations ───────────────────────────────────────────────────────────

function primarySubtag(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * Pick the translation to show for `locale`: an exact tag match, then the
 * same language with another region, then the feed's untagged (default
 * language) text, then the first entry. Empty texts are skipped. The chosen
 * translation keeps its `language`, so a surface can set `lang` on it when it
 * differs from the UI.
 */
export function pickTranslation(
  text: AlertText,
  locale: string,
): AlertTranslation | undefined {
  const candidates = text.filter((entry) => entry.text.trim() !== "");
  if (candidates.length === 0) return undefined;
  const wanted = locale.toLowerCase();
  const exact = candidates.find((entry) => entry.language?.toLowerCase() === wanted);
  if (exact) return exact;
  const primary = primarySubtag(locale);
  const sameLanguage = candidates.find(
    (entry) => entry.language !== undefined && primarySubtag(entry.language) === primary,
  );
  if (sameLanguage) return sameLanguage;
  return candidates.find((entry) => entry.language === undefined) ?? candidates[0];
}
