/**
 * Service-notices contract: the per-generation `service-notices` artifact
 * served by `GET /api/<city>/notices/fetch` and advertised on the bundle
 * response as `X-PT-Notices-Artifact-{Url,Hash,Size}`.
 *
 * Notices describe special services a GTFS feed cannot say on its own (a free
 * seasonal bus, an on-board event, a free-transport evening). They are
 * editor-approved data published with the city's generation, never inferred
 * by the app. The producer resolves local times to UTC windows, so the client
 * only compares instants.
 *
 * Bump {@link SERVICE_NOTICES_SCHEMA_VERSION} on any breaking change; clients
 * ignore bodies whose version they do not understand.
 */

/** Current version of {@link ServiceNoticesBody}. */
export const SERVICE_NOTICES_SCHEMA_VERSION = 1;

export const SERVICE_NOTICE_KINDS = ["seasonal", "event", "free"] as const;
export type ServiceNoticeKind = (typeof SERVICE_NOTICE_KINDS)[number];

/** A half-open UTC interval `[start, end)`, both `YYYY-MM-DDTHH:MM:SSZ`. */
export interface ServiceNoticeWindow {
  start: string;
  end: string;
}

export interface ServiceNotice {
  id: string;
  /** Prepared GTFS `route_id`s; absent when {@link city} is true. */
  routeIds?: string[];
  /** Covers every transit leg in the city; absent when {@link routeIds} is set. */
  city?: true;
  kind: ServiceNoticeKind;
  /** Rides boarding inside a window are free. */
  free: boolean;
  windows: ServiceNoticeWindow[];
  /** Last local calendar day the notice applies (inclusive), `YYYY-MM-DD`. */
  displayUntil: string;
  /** Optional editor text by BCP-47 language tag. */
  text?: Record<string, string>;
  /** Optional editor-chosen badge, one emoji (🎄 Christmas bus, 🔔 choir trip). */
  icon?: string;
  /** `https` link to the operator's announcement. */
  source: string;
}

export interface ServiceNoticesBody {
  schemaVersion: typeof SERVICE_NOTICES_SCHEMA_VERSION;
  notices: ServiceNotice[];
}

/** Manifest/header metadata for the notices artifact, like the transfers artifact. */
export interface RoutingBundleNoticesArtifact {
  url: string;
  hash: string;
  sizeBytes: number;
}

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Mirrors the producer: short, non-empty, no ASCII or whitespace. */
const isIcon = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 16 &&
  !/[\x00-\x7f\s]/u.test(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function isWindow(value: unknown): value is ServiceNoticeWindow {
  if (!isRecord(value)) return false;
  const { start, end } = value;
  return (
    typeof start === "string" && UTC_INSTANT.test(start) &&
    typeof end === "string" && UTC_INSTANT.test(end) &&
    Date.parse(start) < Date.parse(end)
  );
}

function isNotice(value: unknown): value is ServiceNotice {
  if (!isRecord(value)) return false;
  const { id, routeIds, city, kind, free, windows, displayUntil, text, icon, source } = value;
  const hasRoutes = routeIds !== undefined;
  if (hasRoutes === (city !== undefined)) return false;
  if (hasRoutes && !(Array.isArray(routeIds) && routeIds.length > 0 && routeIds.every(isNonEmptyString))) {
    return false;
  }
  if (!hasRoutes && city !== true) return false;
  if (icon !== undefined && !isIcon(icon)) return false;
  if (text !== undefined && !(isRecord(text) && Object.values(text).every(isNonEmptyString))) return false;
  return (
    isNonEmptyString(id) &&
    SERVICE_NOTICE_KINDS.includes(kind as ServiceNoticeKind) &&
    typeof free === "boolean" &&
    Array.isArray(windows) && windows.length > 0 && windows.every(isWindow) &&
    typeof displayUntil === "string" && LOCAL_DATE.test(displayUntil) &&
    typeof source === "string" && source.startsWith("https://")
  );
}

/** True for a body this client understands; anything else is ignored, never shown. */
export function isServiceNoticesBody(value: unknown): value is ServiceNoticesBody {
  return (
    isRecord(value) &&
    value.schemaVersion === SERVICE_NOTICES_SCHEMA_VERSION &&
    Array.isArray(value.notices) &&
    value.notices.every(isNotice)
  );
}
