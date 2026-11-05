import type { Leg, LegStatus, WalkingProgress, TransitProgress } from "@pt/shared";
import { TransportModeIcon } from "../TransportModeIcon.tsx";
import { WalkingLegInfo } from "./WalkingLegInfo.tsx";
import { TransitLegInfo } from "./TransitLegInfo.tsx";
import type { ConnectionStatus } from "./connectionStatus.ts";
import { useTranslation } from "../../i18n/index.ts";
import { useTripDelay } from "../../stores/rtStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";

interface LegRowProps {
  leg: Leg;
  status: LegStatus;
  walkingProgress?: WalkingProgress | null;
  transitProgress?: TransitProgress | null;
  /** Connection intelligence message for upcoming transit legs */
  connectionStatus?: ConnectionStatus | null;
  onTap?: () => void;
}

const STATUS_STYLES: Record<LegStatus, string> = {
  completed: "opacity-50 line-through",
  current: "bg-surface-overlay border-l-4 border-accent",
  upcoming: "opacity-80",
  future: "opacity-40",
};

export function LegRow({
  leg,
  status,
  walkingProgress,
  transitProgress,
  connectionStatus,
  onTap,
}: LegRowProps) {
  const { t, formattingLocale } = useTranslation();
  // The guidance itinerary's leg ISO times are feed-tz-anchored true instants
  // (produced by convertRaptorResults), so render them in the feed tz.
  const feedTz = useCityStore((s) => s.activeCity.tz);
  const isWalking = leg.mode === "WALK" || leg.mode === "BIKE" || leg.mode === "SCOOTER";
  const depTime = new Date(leg.departureTime);
  const arrTime = new Date(leg.arrivalTime);
  const showWalkingProgress = status === "current" && isWalking && !!walkingProgress;
  const showTransitProgress = status === "current" && !isWalking && !!transitProgress;

  // Use live RT delay instead of static leg.delaySeconds.
  // useTripDelay subscribes — see rtStore.ts. Calling getState().getTripDelay
  // here would read a snapshot and miss subsequent RT patches (D-009/D-019).
  const rtResult = useTripDelay(leg.tripId);
  const liveDelay = rtResult ? rtResult.delaySeconds : (leg.delaySeconds ?? 0);

  const formatTime = (d: Date) =>
    d.toLocaleTimeString(formattingLocale, {
      hour: "2-digit",
      minute: "2-digit",
      ...(feedTz ? { timeZone: feedTz } : {}),
    });

  return (
    <button
      // StepList finds rows by this for arrow-key navigation and to move focus
      // to the current leg — without it both found nothing.
      data-testid="leg-row"
      onClick={onTap}
      className={`w-full text-left rounded-lg transition-all ${STATUS_STYLES[status]}`}
      style={{ padding: "var(--variant-row-pad)" }}
    >
      <div className="flex items-center gap-2.5">
        {/* Mode icon + route badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          <TransportModeIcon mode={leg.mode} />
          {leg.routeShortName && (
            <span
              className="text-xs font-bold px-1.5 py-0.5 rounded text-badge-text"
              style={{
                "--route-color": leg.routeColor ? `#${leg.routeColor}` : "#6b7280",
                backgroundColor: "var(--route-color)",
              } as React.CSSProperties}
            >
              {leg.routeShortName}
            </span>
          )}
        </div>

        {/* Time and destination */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-fg-muted" style={{ fontSize: "var(--variant-meta-text-size)" }}>
            <span>{formatTime(depTime)}</span>
            {leg.approximate && !isWalking && (
              <span
                className="text-fg-secondary"
                title={t(
                  "guidance.approximate_title",
                  "Approximate frequency-based departure",
                )}
              >
                {t("guidance.approximate", "approx.")}
              </span>
            )}
            <span>-</span>
            <span>{formatTime(arrTime)}</span>
          </div>

          {/* Status-specific info */}
          {showWalkingProgress && <WalkingLegInfo progress={walkingProgress} />}
          {showTransitProgress && (
            <TransitLegInfo progress={transitProgress} headsign={leg.headsign} />
          )}
          {/* Also on a current leg with no progress yet — a ride that has not
              left, a walk before the first fix — so the row still says where. */}
          {!showWalkingProgress && !showTransitProgress && (
            <div className="text-fg-secondary truncate" style={{ fontSize: "var(--variant-primary-text-size)" }}>
              {leg.headsign ?? leg.to.name}
            </div>
          )}
          {status === "upcoming" && connectionStatus && (
            <div role="status" aria-live="assertive" className={`mt-0.5 ${
              connectionStatus.safety === "atRisk"
                ? "text-danger font-medium"
                : connectionStatus.safety === "extraTime"
                  ? "text-success"
                  : "text-fg-muted"
            }`} style={{ fontSize: "var(--variant-meta-text-size)" }}>
              {connectionStatus.message}
            </div>
          )}
        </div>

        {/* Delay indicator for upcoming transit legs (live RT data) */}
        {status === "upcoming" && !isWalking && liveDelay >= 60 && (
          <span className={`font-bold shrink-0 ${
            liveDelay >= 300 ? "text-danger" : "text-warning"
          }`} style={{ fontSize: "var(--variant-meta-text-size)" }}>
            +{Math.round(liveDelay / 60)} {t("time.min", "min")}
          </span>
        )}
      </div>
    </button>
  );
}
