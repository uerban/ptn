import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/index.ts";
import type { GetOffAlarmState } from "../../hooks/useGetOffAlarm.ts";
import { Icon } from "../Icon.tsx";

const AUTO_DISMISS_MS = 10_000;

interface GetOffAlarmProps {
  alarm: GetOffAlarmState;
}

/**
 * Visual banner displayed above StepList when approaching or arriving at
 * the destination stop. Auto-dismisses after 10 seconds.
 *
 * - Yellow/warning style for "next stop" (1 stop away)
 * - Green/success style for "your stop" (arrived)
 * - role="alert" for screen reader announcement
 */
export function GetOffAlarm({ alarm }: GetOffAlarmProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [currentLevel, setCurrentLevel] = useState(alarm.level);

  // Reset dismissed state when alarm level changes (e.g. next -> arrived)
  useEffect(() => {
    if (alarm.level !== currentLevel) {
      setDismissed(false);
      setCurrentLevel(alarm.level);
    }
  }, [alarm.level, currentLevel]);

  // Auto-dismiss after 10 seconds
  useEffect(() => {
    if (!alarm.level || dismissed) return;
    const timer = setTimeout(() => setDismissed(true), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [alarm.level, dismissed]);

  if (!alarm.level || dismissed) return null;

  const stopDisplay = alarm.stopName ?? "...";

  const isArrived = alarm.level === "arrived";

  const message = isArrived
    ? t("alarm.your_stop", "This is your stop: {stop}").replace("{stop}", stopDisplay)
    : t("alarm.next_stop", "Get ready! Your stop is next: {stop}").replace("{stop}", stopDisplay);

  return (
    <div
      role="alert"
      data-testid="get-off-alarm"
      className={`mx-3 mb-2 px-4 py-3 rounded-xl shadow-2 flex items-center gap-3 animate-[slideIn_0.3s_ease-out] ${
        isArrived
          ? "bg-emerald-500/95 text-white"
          : "bg-amber-400/95 text-amber-950"
      }`}
    >
      {/* Icon */}
      <div className="shrink-0">
        {isArrived ? (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        )}
      </div>

      {/* Message */}
      <span className="text-sm font-semibold flex-1">{message}</span>

      {/* Dismiss button */}
      <button
        onClick={() => setDismissed(true)}
        className={`shrink-0 p-1 rounded-full ${
          isArrived ? "hover:bg-white/20" : "hover:bg-amber-950/10"
        }`}
        aria-label="Dismiss"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
