import { useState, useCallback } from "react";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useDelayReportStore } from "../../stores/delayReportStore.ts";
import { useTranslation } from "../../i18n/index.ts";
import type { DelayCategory } from "../../stores/delayReportStore.ts";
import type { LatLon } from "@pt/shared";
import { Icon } from "../Icon.tsx";

interface DelayReportProps {
  position?: LatLon | null;
}

const DELAY_OPTIONS: { category: DelayCategory; labelKey: string; fallback: string }[] = [
  { category: "on_time", labelKey: "delay.on_time", fallback: "On time" },
  { category: "slight", labelKey: "delay.slight", fallback: "Slight delay (2-5 min)" },
  { category: "significant", labelKey: "delay.significant", fallback: "Significant delay (5-15 min)" },
  { category: "major", labelKey: "delay.major", fallback: "Major delay (15+ min)" },
  { category: "cancelled", labelKey: "delay.cancelled", fallback: "Cancelled" },
];

export function DelayReport({ position }: DelayReportProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);

  const currentLeg = itinerary?.legs[currentLegIndex] ?? null;

  const handleSubmit = useCallback(
    (category: DelayCategory) => {
      if (!currentLeg?.tripId || !currentLeg?.routeShortName) return;

      useDelayReportStore.getState().addReport({
        tripId: currentLeg.tripId,
        routeId: currentLeg.tripId.split(":")[0] || currentLeg.tripId,
        routeShortName: currentLeg.routeShortName,
        timestamp: Date.now(),
        category,
        location: position ?? undefined,
      });

      setOpen(false);
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 3000);
    },
    [currentLeg, position],
  );

  // Only show during active navigation on a transit leg
  if (phase !== "navigating") return null;
  if (!currentLeg || !currentLeg.tripId) return null;

  return (
    <div className="px-4 pb-2" data-testid="delay-report">
      {!open && !submitted && (
        <button
          type="button"
          data-testid="delay-report-btn"
          onClick={() => setOpen(true)}
          className="w-full py-2 px-4 rounded-lg bg-surface-overlay border border-divider
            text-sm font-medium text-fg-secondary hover:bg-surface-raised
            flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {t("delay.report_button", "Report delay")}
        </button>
      )}

      {submitted && (
        <div
          data-testid="delay-report-thanks"
          className="w-full py-2 px-4 rounded-lg bg-success/10 border border-success/30
            text-sm font-medium text-success text-center"
        >
          {t("delay.thanks", "Thanks for reporting!")}
        </div>
      )}

      {open && (
        <div
          data-testid="delay-report-options"
          className="bg-surface-raised rounded-xl shadow-2 p-3 space-y-1.5"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-fg">
              {t("delay.how_is_trip", "How is your trip?")}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 rounded-full hover:bg-surface-overlay"
              aria-label="Close"
            >
              <Icon name="close" size={16} className="text-fg-muted" />
            </button>
          </div>

          {DELAY_OPTIONS.map((opt) => (
            <button
              key={opt.category}
              type="button"
              data-testid={`delay-option-${opt.category}`}
              onClick={() => handleSubmit(opt.category)}
              className={`w-full text-left py-2 px-3 rounded-lg text-sm font-medium
                hover:bg-surface-overlay border border-transparent
                ${opt.category === "on_time" ? "text-success" : ""}
                ${opt.category === "slight" ? "text-warning" : ""}
                ${opt.category === "significant" ? "text-warning" : ""}
                ${opt.category === "major" ? "text-danger" : ""}
                ${opt.category === "cancelled" ? "text-danger" : ""}
              `}
            >
              {t(opt.labelKey, opt.fallback)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
