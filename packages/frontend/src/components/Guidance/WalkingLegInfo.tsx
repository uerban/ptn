import type { WalkingProgress } from "@pt/shared";
import { cardinalDirection } from "../../utils/geo.ts";
import { useTranslation } from "../../i18n/index.ts";
import { WALK_STEP_SEPARATOR, walkStepParts } from "../../utils/walkStepText.ts";

interface WalkingLegInfoProps {
  progress: WalkingProgress;
}

export function WalkingLegInfo({ progress }: WalkingLegInfoProps) {
  const { t } = useTranslation();
  // "NW" is an abbreviation of a word, so it is translated like one — a
  // Cyrillic UI writes "ПнЗ", not "NW".
  const cardinal = progress.bearingDegrees !== null
    ? cardinalDirection(progress.bearingDegrees)
    : null;
  const direction = cardinal
    ? t(`cardinal.${cardinal.toLowerCase()}`, cardinal)
    : null;
  const minutes = Math.ceil(progress.estimatedSecondsRemaining / 60);
  const step = progress.nextStep ? walkStepParts(t, progress.nextStep) : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Whole strings side by side, never composed into one sentence; the
          element's text still reads as one line: "42 m · Turn left · Pylimo g." */}
      {step && (
        <span data-testid="walk-next-step" className="text-fg font-medium" style={{ fontSize: "var(--variant-primary-text-size)" }}>
          {[step.distance, ...step.actions].join(WALK_STEP_SEPARATOR)}
          {step.name && (
            <span className="text-fg-secondary font-normal">
              {WALK_STEP_SEPARATOR}
              {step.name}
            </span>
          )}
        </span>
      )}
      <div className="flex items-center gap-3" style={{ fontSize: "var(--variant-primary-text-size)" }}>
        {/* The cardinal hint is for straight-line legs; next to a real
            instruction it would only compete with it. */}
        {direction && !step && (
          <span className="text-fg font-medium">
            {t("guidance.walk_direction", "Walk")} {direction}
          </span>
        )}
        <span data-countdown className="text-fg-secondary" style={{ fontSize: "var(--variant-meta-text-size)" }}>
          {t("unit.meters", "{n} m").replace(
            "{n}",
            String(progress.distanceRemainingMeters),
          )}
        </span>
        <span data-countdown className="text-fg-muted" style={{ fontSize: "var(--variant-meta-text-size)" }}>
          ~{minutes} {t("time.min", "min")}
        </span>
      </div>
    </div>
  );
}
