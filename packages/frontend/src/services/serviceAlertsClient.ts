/**
 * Service alerts client.
 *
 * One city-wide request (`GET /api/<city>/alerts`, revalidated with
 * `If-None-Match`), so the server learns only the city, never which stop,
 * line or trip is on screen; matching happens on the device
 * (`serviceAlertSelection.ts`).
 *
 * Requests run only while
 * - at least one alert surface is subscribed (visible),
 * - the document is visible,
 * - `canUse("operator.service-alerts")` holds, and
 * - the city's stored realtime availability lists `alerts`.
 *
 * When any of these stops holding, polling stops; when the decision is
 * revoked or the city loses alerts, the in-flight request is aborted and the
 * alerts held in memory are dropped. `canUse` is checked again before a
 * response is applied, so a late answer cannot outlive a revocation (also one
 * made in another tab). Alerts are kept in memory only, never persisted.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  SERVICE_ALERTS_SCHEMA_VERSION,
  type Alert,
  type AlertSeverity,
  type ServiceAlertsResponse,
} from "@pt/shared";
import { canUse } from "../privacy/canUse.ts";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import {
  isRealtimeKindAvailable,
  subscribeRealtimeAvailability,
} from "./realtimeAvailability.ts";

export const SERVICE_ALERTS_FLOW_ID = "operator.service-alerts";

/** Poll interval while a surface is visible. */
export const SERVICE_ALERTS_POLL_MS = 60_000;
/** Retry interval after a failed request. */
export const SERVICE_ALERTS_RETRY_MS = 30_000;

export type ServiceAlertsStatus =
  /** No decision allowing the flow: nothing is requested. */
  | "blocked"
  /** The city does not offer alerts (or its availability is unknown). */
  | "unavailable"
  /** Allowed and available; the first answer has not arrived yet. */
  | "loading"
  /** `response` holds the latest answer. */
  | "ready"
  /** The last request failed; `response` may still hold an older answer. */
  | "failed";

export interface ServiceAlertsSnapshot {
  readonly city: string;
  readonly status: ServiceAlertsStatus;
  readonly response?: ServiceAlertsResponse;
  /** Epoch ms of the last successful check (200 or 304). */
  readonly checkedAt?: number;
}

export interface ServiceAlertsClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

let options: Required<ServiceAlertsClientOptions> = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
};

function alertsUrl(city: string): string {
  return `/api/${encodeURIComponent(city)}/alerts`;
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function flowAllowed(): boolean {
  return canUse(SERVICE_ALERTS_FLOW_ID);
}

// ─── Response validation (untrusted input) ─────────────────────────────────

function isTextList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
  );
}

const SEVERITIES: ReadonlySet<string> = new Set<AlertSeverity>([
  "UNKNOWN",
  "INFO",
  "WARNING",
  "SEVERE",
]);

function isAlert(value: unknown): value is Alert {
  if (!value || typeof value !== "object") return false;
  const alert = value as Record<string, unknown>;
  return (
    typeof alert.id === "string" &&
    typeof alert.severity === "string" &&
    isTextList(alert.header) &&
    isTextList(alert.description) &&
    isTextList(alert.url) &&
    Array.isArray(alert.activePeriods) &&
    Array.isArray(alert.informedEntities)
  );
}

/** Accept a body only in the schema version this client understands, for
 * the city it asked about. Malformed alerts are dropped individually. */
export function parseServiceAlertsResponse(
  body: unknown,
  city: string,
): ServiceAlertsResponse | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;
  if (raw.schemaVersion !== SERVICE_ALERTS_SCHEMA_VERSION) return undefined;
  if (raw.city !== city) return undefined;
  if (typeof raw.fetchedAt !== "string" || typeof raw.stale !== "boolean") {
    return undefined;
  }
  if (!Array.isArray(raw.alerts)) return undefined;
  return {
    schemaVersion: SERVICE_ALERTS_SCHEMA_VERSION,
    city,
    fetchedAt: raw.fetchedAt,
    stale: raw.stale,
    // A severity this client does not know reads as unknown.
    alerts: raw.alerts
      .filter(isAlert)
      .map((alert) =>
        SEVERITIES.has(alert.severity) ? alert : { ...alert, severity: "UNKNOWN" as const },
      ),
  };
}

// ─── Per-city feed ─────────────────────────────────────────────────────────

class CityAlertsFeed {
  private readonly listeners = new Set<() => void>();
  private snapshot: ServiceAlertsSnapshot;
  private etag: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private detach: (() => void) | undefined;
  /** Epoch ms when the last request completed, successfully or not. */
  private lastAttemptAt: number | undefined;

  constructor(readonly city: string) {
    this.snapshot = { city, status: "blocked" };
  }

  getSnapshot(): ServiceAlertsSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.attach();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.release();
    };
  }

  private attach(): void {
    const reevaluate = () => this.evaluate();
    const stopDecisions = useNetworkDecisionsStore.subscribe(reevaluate);
    const stopAvailability = subscribeRealtimeAvailability(reevaluate);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", reevaluate);
    }
    this.detach = () => {
      stopDecisions();
      stopAvailability();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", reevaluate);
      }
    };
    this.evaluate();
  }

  /** No surface left: stop requesting. The last answer stays in memory. */
  private release(): void {
    this.detach?.();
    this.detach = undefined;
    this.clearTimer();
    this.abort();
  }

  /** Stop everything and forget the alerts (revocation, lost availability). */
  private shutDown(status: "blocked" | "unavailable"): void {
    this.clearTimer();
    this.abort();
    this.etag = undefined;
    this.lastAttemptAt = undefined;
    this.set({ city: this.city, status });
  }

  private evaluate(): void {
    if (this.listeners.size === 0) return;
    if (!flowAllowed()) return this.shutDown("blocked");
    if (!isRealtimeKindAvailable(this.city, "alerts")) {
      return this.shutDown("unavailable");
    }
    if (this.snapshot.status === "blocked" || this.snapshot.status === "unavailable") {
      this.set({ city: this.city, status: "loading" });
    }
    if (!documentVisible()) {
      // Paused while hidden; an in-flight request may still land.
      this.clearTimer();
      return;
    }
    if (this.timer !== undefined || this.controller !== undefined) return;
    const due =
      this.lastAttemptAt === undefined
        ? 0
        : this.lastAttemptAt + this.nextInterval() - options.now();
    if (due <= 0) void this.request();
    else this.schedule(due);
  }

  private nextInterval(): number {
    return this.snapshot.status === "failed"
      ? SERVICE_ALERTS_RETRY_MS
      : SERVICE_ALERTS_POLL_MS;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.canRequest()) void this.request();
    }, delayMs);
  }

  private canRequest(): boolean {
    return (
      this.listeners.size > 0 &&
      documentVisible() &&
      flowAllowed() &&
      isRealtimeKindAvailable(this.city, "alerts")
    );
  }

  private stillWanted(controller: AbortController): boolean {
    return (
      this.controller === controller &&
      !controller.signal.aborted &&
      flowAllowed() &&
      isRealtimeKindAvailable(this.city, "alerts")
    );
  }

  private async request(): Promise<void> {
    // Request boundary: check the decision right before the request leaves.
    if (!this.canRequest()) return;
    const controller = new AbortController();
    this.controller = controller;
    const outcome = await this.fetchAlerts(controller.signal);
    // Apply only if nothing revoked or replaced this request meanwhile.
    if (!this.stillWanted(controller)) {
      if (this.controller === controller) this.controller = undefined;
      return;
    }
    this.controller = undefined;
    const now = options.now();
    this.lastAttemptAt = now;
    if (outcome.failed) {
      this.set({ ...this.snapshot, status: "failed" });
    } else if (outcome.notModified) {
      this.set({
        city: this.city,
        status: "ready",
        response: this.snapshot.response,
        checkedAt: now,
      });
    } else {
      this.etag = outcome.etag;
      this.set({
        city: this.city,
        status: "ready",
        response: outcome.response,
        checkedAt: now,
      });
    }
    if (this.listeners.size > 0 && documentVisible()) {
      this.schedule(this.nextInterval());
    }
  }

  private async fetchAlerts(signal: AbortSignal): Promise<{
    failed?: true;
    response?: ServiceAlertsResponse;
    notModified?: true;
    etag?: string;
  }> {
    try {
      let res = await this.send(signal);
      if (res.status === 304 && !this.snapshot.response) {
        // Nothing held to keep (dropped after a revocation in the meantime):
        // ask once more for the full answer.
        this.etag = undefined;
        res = await this.send(signal);
      }
      if (res.status === 304 && this.snapshot.response) return { notModified: true };
      if (!res.ok) return { failed: true };
      const response = parseServiceAlertsResponse(await res.json(), this.city);
      return response
        ? { response, etag: res.headers.get("ETag") ?? undefined }
        : { failed: true };
    } catch {
      return { failed: true };
    }
  }

  private send(signal: AbortSignal): Promise<Response> {
    const headers = new Headers();
    if (this.etag) headers.set("If-None-Match", this.etag);
    return options.fetch(alertsUrl(this.city), {
      headers,
      signal,
      // The page URL can name a stop, line or place (`/line/<id>`,
      // `/search?…`); the request must name only the city.
      referrerPolicy: "no-referrer",
      credentials: "omit",
    });
  }

  private abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(next: ServiceAlertsSnapshot): void {
    const prev = this.snapshot;
    if (
      prev.status === next.status &&
      prev.response === next.response &&
      prev.checkedAt === next.checkedAt
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A failing surface must not stop the others.
      }
    }
  }

  dispose(): void {
    this.release();
    this.listeners.clear();
  }
}

const feeds = new Map<string, CityAlertsFeed>();

function feedFor(city: string): CityAlertsFeed {
  let feed = feeds.get(city);
  if (!feed) {
    feed = new CityAlertsFeed(city);
    feeds.set(city, feed);
  }
  return feed;
}

/**
 * Register a visible alert surface for `city`. Polling runs while at least
 * one surface is registered. Returns an unsubscriber.
 */
export function subscribeServiceAlerts(
  city: string,
  listener: () => void,
): () => void {
  return feedFor(city).subscribe(listener);
}

export function getServiceAlertsSnapshot(city: string): ServiceAlertsSnapshot {
  return feedFor(city).getSnapshot();
}

const IDLE_SNAPSHOT: ServiceAlertsSnapshot = Object.freeze({
  city: "",
  status: "unavailable",
});

/**
 * React binding for an alert surface. Pass `visible = false` (or no city)
 * while the surface is not shown, so it stops counting towards polling.
 */
export function useServiceAlerts(
  city: string | undefined,
  visible = true,
): ServiceAlertsSnapshot {
  const active = visible && !!city;
  const subscribe = useCallback(
    (listener: () => void) =>
      active && city ? subscribeServiceAlerts(city, listener) : () => {},
    [active, city],
  );
  const getSnapshot = useCallback(
    () => (active && city ? getServiceAlertsSnapshot(city) : IDLE_SNAPSHOT),
    [active, city],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: drop every feed and restore the default dependencies. */
export function __resetServiceAlertsForTests(
  overrides: ServiceAlertsClientOptions = {},
): void {
  for (const feed of feeds.values()) feed.dispose();
  feeds.clear();
  options = {
    fetch: overrides.fetch ?? ((...args) => globalThis.fetch(...args)),
    now: overrides.now ?? (() => Date.now()),
  };
}
