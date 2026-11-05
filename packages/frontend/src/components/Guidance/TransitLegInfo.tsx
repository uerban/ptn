import type { TransitProgress } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { pluralize } from "../../i18n/plurals.ts";

interface TransitLegInfoProps {
  progress: TransitProgress;
  headsign?: string;
}

export function TransitLegInfo({ progress, headsign }: TransitLegInfoProps) {
  const { t, locale } = useTranslation();
  const delayMinutes = Math.round(progress.delaySeconds / 60);

  return (
    <div className="flex items-center gap-3" style={{ fontSize: "var(--variant-primary-text-size)" }}>
      {progress.currentStopName && (
        <span className="text-fg font-medium truncate">
          {progress.currentStopName}
        </span>
      )}
      <span data-countdown className="text-fg-secondary">
        {progress.stopsRemaining}{" "}
        {pluralize(
          locale,
          progress.stopsRemaining,
          t("route.stop_one", "stop"),
          t("route.stop_few", "stops"),
          t("route.stop_many", "stops"),
        )}
      </span>
      {delayMinutes > 0 && (
        <span data-countdown className={`font-bold ${delayMinutes >= 5 ? "text-danger" : "text-warning"}`} style={{ fontSize: "var(--variant-meta-text-size)" }}>
          +{delayMinutes} {t("time.min", "min")}
        </span>
      )}
      {headsign && !progress.currentStopName && (
        <span className="text-fg-muted truncate">
          {headsign}
        </span>
      )}
    </div>
  );
}
