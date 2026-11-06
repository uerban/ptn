import { useState, useEffect } from "react";
import { useCityStore } from "../../stores/cityStore.ts";
import { useTranslation } from "../../i18n/index.ts";
import { CITIES } from "../../config/cities.ts";

// Per-city stale-feed thresholds (seconds). Until CityConfig gains a
// `feedStaleAfterSeconds` field, only cities whose backend exposes
// feedAgeSeconds with a known stale-cadence opt in here — listing every
// city with a generic 18h default would actively mask staleness for cities
// that refresh every 6h.
const STALE_FEED_THRESHOLD_BY_CITY: Record<string, number> = {};

/**
 * How many probes in a row must fail to REACH the backend before the copy
 * switches from "warming up" to "the server is down". At the 30 s poll cadence
 * that is ~30 s of silence: long enough not to cry wolf over one dropped
 * request on a flaky link, short enough that a real outage is labelled
 * correctly rather than telling the rider that data "will appear shortly"
 * while the map sits empty.
 *
 * pt-serve's ~15 s self-reload window returns 503 and keeps the startup
 * copy. Gateway failures (502/504) mean the proxy cannot reach the reader;
 * they count toward an outage just like a failed network request.
 */
const OUTAGE_AFTER_CONSECUTIVE_FAILURES = 2;

type ProbeState =
  /** 2xx from the backend. */
  | "ok"
  /** Answered, but not ready (503 during self-reload). */
  | "not-ready"
  /** No answer at all — DNS, connection, gateway, or device offline. */
  | "unreachable";

export function BackendStatus() {
  const { t } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const cityName = CITIES.find((c) => c.id === cityId)?.name ?? cityId;
  const staleThreshold = STALE_FEED_THRESHOLD_BY_CITY[cityId];
  const [probe, setProbe] = useState<{ state: ProbeState; consecutiveUnreachable: number }>(
    { state: "ok", consecutiveUnreachable: 0 },
  );
  const [feedAgeSeconds, setFeedAgeSeconds] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const healthUrl = `/api/${cityId}/health/ready`;
    setProbe({ state: "ok", consecutiveUnreachable: 0 });
    setFeedAgeSeconds(null);

    function unreachable() {
      setProbe((prev) => ({
        state: "unreachable",
        consecutiveUnreachable: prev.consecutiveUnreachable + 1,
      }));
    }

    async function checkHealth() {
      try {
        // `cache: "no-store"` for the HTTP cache; the service worker keeps its
        // hands off via the /health NetworkOnly rule in sw/runtimeCaching.ts.
        // A replayed probe answers "was the backend up earlier", which is the
        // one thing a probe must never say.
        const res = await fetch(healthUrl, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 503) {
            setProbe({ state: "not-ready", consecutiveUnreachable: 0 });
          } else {
            unreachable();
          }
          return;
        }
        setProbe({ state: "ok", consecutiveUnreachable: 0 });
        let body: { feedAgeSeconds?: number | null } | null = null;
        try { body = await res.json() as { feedAgeSeconds?: number | null }; }
        catch (err) {
          // Malformed body (proxy rewrite bug, gateway HTML leaking through 200)
          // — warn so the misroute surfaces; keep previous feedAge.
          console.warn("BackendStatus: malformed health JSON for", cityId, err);
          return;
        }
        if (cancelled) return;
        setFeedAgeSeconds(typeof body?.feedAgeSeconds === "number" ? body.feedAgeSeconds : null);
      } catch (err) {
        console.warn("Health check failed:", err);
        if (!cancelled) {
          unreachable();
        }
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cityId]);

  // Sustained outage. The map is running off the on-device PTB bundle
  // (stopStore's bundle floor) and departures cannot refresh, so say that
  // instead of promising data "shortly".
  if (
    probe.state === "unreachable" &&
    probe.consecutiveUnreachable >= OUTAGE_AFTER_CONSECUTIVE_FAILURES
  ) {
    return (
      <div
        className="bg-warning/10 text-warning text-xs text-center py-1.5 px-4"
        role="status"
        aria-live="polite"
      >
        {t(
          "status.backend_unreachable",
          "Server unreachable — showing the saved schedule. Departure times may be out of date.",
        )}
      </div>
    );
  }

  if (probe.state !== "ok") {
    return (
      <div
        className="bg-warning/10 text-warning text-xs text-center py-1.5 px-4"
        role="status"
        aria-live="polite"
      >
        {t(
          "status.backend_loading",
          "Transit data is loading — departures and routes will appear shortly",
        )}
      </div>
    );
  }

  if (staleThreshold !== undefined && feedAgeSeconds !== null && feedAgeSeconds > staleThreshold) {
    // floor so 17h30m doesn't read as "18h ago"
    const hours = Math.floor(feedAgeSeconds / 3600);
    const message = t(
      "status.feed_stale",
      "schedules were last refreshed {hours}h ago. Times may be slightly off; routes and stops are still accurate.",
    ).replace("{hours}", String(hours));
    return (
      <div
        className="bg-warning/10 text-warning text-xs text-center py-1.5 px-4"
        role="status"
        aria-live="polite"
      >
        {cityName} {message}
      </div>
    );
  }

  return null;
}
