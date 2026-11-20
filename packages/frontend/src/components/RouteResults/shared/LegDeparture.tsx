import type { Leg } from "@pt/shared";
import { useTranslation } from "../../../i18n/index.ts";
import { formatTime } from "./format.ts";

export function LegDeparture({ leg, feedTz }: { leg: Leg; feedTz?: string }) {
  const { t, formattingLocale } = useTranslation();
  const hasTime = Number.isFinite(Date.parse(leg.departureTime));
  if (!leg.headsign && !hasTime) return null;

  return (
    <span className="min-w-0 break-words text-xs text-fg-muted tabular-nums">
      {leg.headsign && t("route.toward_headsign", "toward {headsign}").replace("{headsign}", leg.headsign)}
      {leg.headsign && hasTime && " · "}
      {hasTime && (
        <time dateTime={leg.departureTime} className="whitespace-nowrap">
          {leg.approximate && <>{t("guidance.approximate", "approx.")} </>}
          {formatTime(leg.departureTime, formattingLocale, feedTz)}
        </time>
      )}
    </span>
  );
}
