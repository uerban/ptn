import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "../../i18n/index.ts";
import { useTransitous } from "../../hooks/useTransitous.ts";
import type { TransitousPlanArgs } from "../../services/transitousClient.ts";
import { getRoutingProvider } from "../../config/routingProviders.ts";

/** The declared plan args the panel forwards to `run`, plus the render-only
 *  `feedTz` (required key, may be unknown — forces
 *  every call site to consciously pass it; a silently-absent feedTz yields wrong
 *  cross-tz wall-clock times). */
export interface TransitousPanelProps extends TransitousPlanArgs {
  feedTz: string | undefined;
  /** Remote-primary transport failure falls back to on-device routing. */
  onFallback?: () => void;
}

const provider = getRoutingProvider("transitous");

function fmtTime(iso: string, feedTz: string | undefined, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(feedTz ? { timeZone: feedTz } : {}),
  }).format(new Date(iso));
}

/** Standing-provider transitous result surface. Search renders it only when
 *  the selected strategy dispatches to transitous and the live privacy policy
 *  allows that provider. Selection and field disclosure live in Settings, so
 *  this panel starts the request without a repetitive consent interruption. */
export function TransitousPanel({
  from,
  to,
  departAtIso,
  feedTz,
  onFallback,
}: TransitousPanelProps) {
  const { t, formattingLocale } = useTranslation();
  const { state, run } = useTransitous();
  const args = useMemo(
    () => ({ from, to, departAtIso }),
    [from, to, departAtIso],
  );
  const requestKey = `${from.lat}:${from.lon}:${to.lat}:${to.lon}:${departAtIso}`;
  const lastStartedRef = useRef<string | null>(null);
  const lastFallbackRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastStartedRef.current === requestKey) return;
    lastStartedRef.current = requestKey;
    // Suppress the previous query's terminal state during the single render
    // before run() advances this query to pending.
    lastFallbackRef.current = requestKey;
    void run(args);
  }, [requestKey, run, args]);

  useEffect(() => {
    if (
      state.status === "pending" &&
      lastStartedRef.current === requestKey
    ) {
      lastFallbackRef.current = null;
      return;
    }
    if (
      state.status !== "done" ||
      (state.outcome.kind !== "failure" && state.outcome.kind !== "offline") ||
      !onFallback ||
      lastFallbackRef.current === requestKey
    ) {
      return;
    }
    lastFallbackRef.current = requestKey;
    onFallback();
  }, [state, onFallback, requestKey]);

  if (state.status === "idle" || state.status === "pending") {
    return (
      <div className="mt-3 text-sm text-fg-muted" data-testid="transitous-pending">
        {t("transitous.searching", `Searching ${provider.name}…`)}
      </div>
    );
  }

  if (state.status === "done") {
    const o = state.outcome;
    // A switch (not an if-chain) so a future TransitousOutcome.kind fails the
    // build at `assertNever` instead of silently rendering nothing.
    switch (o.kind) {
      case "offline":
        return (
          <div className="mt-3 text-left" data-testid="transitous-offline">
            <p className="text-sm text-fg-muted mb-2">
              {t("transitous.offline", "You're offline — transitous needs a connection.")}
            </p>
            <RetryButton t={t} onRetry={() => void run(args)} />
          </div>
        );
      case "failure":
        return (
          <div className="mt-3 text-left" data-testid="transitous-failure">
            <p className="text-sm text-danger mb-2">
              {t("transitous.failure", `Couldn't reach ${provider.name}.`)}
            </p>
            <RetryButton t={t} onRetry={() => void run(args)} />
          </div>
        );
      case "empty":
        return (
          <div className="mt-3 text-sm text-fg-muted" data-testid="transitous-empty">
            {t("transitous.empty", `${provider.name} has no route here.`)}
          </div>
        );
      case "results": {
        const it = o.itineraries[0]; // non-empty tuple ⇒ provably present
        return (
          <div className="mt-3 text-left" data-testid="transitous-results">
            <p className="text-xs text-fg-muted mb-1">
              {t("transitous.source_label", `Results from ${provider.name} (third-party)`)}
            </p>
            <ol className="space-y-1">
              {it.legs.map((leg, i) => (
                <li key={i} className="text-sm flex items-center gap-2">
                  <span className="font-medium" style={leg.routeColor ? { color: leg.routeColor } : undefined}>
                    {leg.routeShortName ?? t(`mode.${leg.mode.toLowerCase()}`, leg.mode)}
                  </span>
                  <span className="text-fg-muted">
                    {fmtTime(leg.departIso, feedTz, formattingLocale)} {leg.fromName} → {fmtTime(leg.arriveIso, feedTz, formattingLocale)} {leg.toName}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        );
      }
      default:
        return assertNever(o);
    }
  }

  return null;
}

/** Compile-time exhaustiveness guard: a new outcome kind that reaches here is a
 *  type error at the call site, not a silent blank render. */
function assertNever(x: never): never {
  throw new Error(`Unhandled transitous outcome: ${JSON.stringify(x)}`);
}

/** The retry control for failure / offline states — re-fires the same
 *  `run` so the copy's promised action actually exists. */
function RetryButton({ t, onRetry }: { t: (k: string, f?: string) => string; onRetry: () => void }) {
  return (
    <button
      type="button"
      data-testid="transitous-retry"
      className="w-full py-2 text-sm text-accent border border-accent rounded-lg hover:bg-accent/10"
      onClick={onRetry}
    >
      {t("transitous.retry", "Try again")}
    </button>
  );
}
