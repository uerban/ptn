import { memo } from "react";
import { useTranslation } from "../../../i18n/index.ts";
import { Icon } from "../../Icon.tsx";

/**
 * Card-level real-time trust banner.
 *
 * `applyRtOverlay` produces two independent signals and this renders the
 * one that fired. They are not interchangeable: `cancelled` is a fact
 * reported by the operator, `unreliable` is an inference that the leg
 * chain no longer connects after delays. An itinerary can raise both, in
 * which case the caller shows the cancellation — it is the stronger
 * claim and already implies the timing cannot be trusted.
 *
 * Severity follows the existing convention for cancelled departures
 * (`DepartureSheet/LineGroup`): cancelled is `danger`, degraded-but-
 * running is `warning`.
 */
export type RtWarningReason = "cancelled" | "unreliable";

const COPY: Record<RtWarningReason, { key: string; fallback: string; tone: string }> = {
  cancelled: {
    key: "rt.cancelled_warning",
    fallback: "Trip is cancelled",
    tone: "bg-danger/10 text-danger",
  },
  unreliable: {
    key: "rt.timing_unreliable_warning",
    fallback: "Trip has unreliable timing",
    tone: "bg-warning/10 text-warning",
  },
};

export const RtWarningBanner = memo(function RtWarningBanner({
  reason,
}: {
  reason: RtWarningReason;
}) {
  const { t } = useTranslation();
  const { key, fallback, tone } = COPY[reason];
  return (
    <div
      data-testid={`rt-warning-banner-${reason}`}
      role="status"
      aria-live="polite"
      className={`flex items-center gap-1.5 ${tone} text-xs py-1.5 px-2 rounded`}
    >
      <Icon name="warning" size={14} />
      <span>{t(key, fallback)}</span>
    </div>
  );
});
