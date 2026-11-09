/**
 * Service-alert contract served by `GET /api/<city>/alerts`.
 *
 * The shape follows GTFS-RT `Alert` closely so nothing a feed says is lost on
 * the way to the client: translated texts stay translation lists, active
 * periods stay a list, and affected entities stay selectors rather than flat
 * route/stop lists (a flat list cannot say "route X, but only at stop Y").
 *
 * Bump {@link SERVICE_ALERTS_SCHEMA_VERSION} on any breaking change; clients
 * ignore responses whose version they do not understand.
 */

/** Current version of {@link ServiceAlertsResponse}. */
export const SERVICE_ALERTS_SCHEMA_VERSION = 1;

/** GTFS-RT `Alert.Cause`, by enum name. */
export type AlertCause =
  | "UNKNOWN_CAUSE"
  | "OTHER_CAUSE"
  | "TECHNICAL_PROBLEM"
  | "STRIKE"
  | "DEMONSTRATION"
  | "ACCIDENT"
  | "HOLIDAY"
  | "WEATHER"
  | "MAINTENANCE"
  | "CONSTRUCTION"
  | "POLICE_ACTIVITY"
  | "MEDICAL_EMERGENCY";

/** GTFS-RT `Alert.Effect`, by enum name. */
export type AlertEffect =
  | "NO_SERVICE"
  | "REDUCED_SERVICE"
  | "SIGNIFICANT_DELAYS"
  | "DETOUR"
  | "ADDITIONAL_SERVICE"
  | "MODIFIED_SERVICE"
  | "OTHER_EFFECT"
  | "UNKNOWN_EFFECT"
  | "STOP_MOVED"
  | "NO_EFFECT"
  | "ACCESSIBILITY_ISSUE";

/**
 * GTFS-RT `Alert.SeverityLevel`. `UNKNOWN` stands for `UNKNOWN_SEVERITY`, which
 * is also what an alert without a severity level carries.
 */
export const ALERT_SEVERITIES = ["UNKNOWN", "INFO", "WARNING", "SEVERE"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * One translation of a GTFS-RT `TranslatedString`. `language` is a BCP-47 tag;
 * absent means the feed did not label it (the feed's default language).
 */
export interface AlertTranslation {
  language?: string;
  text: string;
}

/** A translated text: every translation the feed published, in feed order. */
export type AlertText = AlertTranslation[];

/**
 * GTFS-RT `TimeRange` as ISO 8601 UTC instants. A missing `start` means "since
 * forever", a missing `end` means "until further notice".
 */
export interface AlertActivePeriod {
  start?: string;
  end?: string;
}

/**
 * GTFS-RT `EntitySelector`, with IDs resolved to the served bundle's IDs.
 *
 * Fields present in one selector are ANDed; the selectors of an alert are
 * ORed. A selector always carries at least one field.
 */
export interface AlertInformedEntity {
  agencyId?: string;
  routeId?: string;
  /** GTFS `route_type`. */
  routeType?: number;
  /** GTFS `direction_id` (0 or 1). */
  directionId?: number;
  tripId?: string;
  stopId?: string;
}

/** A service alert. */
export interface Alert {
  /** Feed entity id; unique within one response. */
  id: string;
  cause: AlertCause;
  effect: AlertEffect;
  severity: AlertSeverity;
  header: AlertText;
  description: AlertText;
  /** Translated URLs for more information; empty when the feed gives none. */
  url: AlertText;
  /** Empty means always active. */
  activePeriods: AlertActivePeriod[];
  informedEntities: AlertInformedEntity[];
}

/** Body of `GET /api/<city>/alerts`. */
export interface ServiceAlertsResponse {
  schemaVersion: typeof SERVICE_ALERTS_SCHEMA_VERSION;
  /** City slug the alerts belong to. */
  city: string;
  /** ISO 8601 UTC instant of the last successful upstream fetch. */
  fetchedAt: string;
  /** True when the last successful fetch is older than the server's freshness threshold. */
  stale: boolean;
  alerts: Alert[];
}
