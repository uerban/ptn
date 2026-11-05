import { useTranslation } from "../../../i18n/index.ts";

interface Props {
  minutes: number;
  stopName: string;
}

/**
 * Wait-row variant for the Accessible card. The Accessible variant has no
 * `ItineraryBar` (intentionally simplified chrome), so wait segments need
 * a dedicated row in the same chrome as `AccessibleLegRow`. Unlike that
 * component, this one has no `Leg` — just a bare wait + stop name.
 *
 * Same shape used for both pre-stop buffer waits and inter-leg transfer waits.
 */
export function AccessibleWaitRow({ minutes, stopName }: Props) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-3 rounded-xl bg-surface-overlay px-3 py-2.5 min-h-[3rem] text-fg"
      role="listitem"
    >
      <span aria-hidden className="text-2xl">
        ⏱
      </span>
      <span className="text-base">
        {t("route.accessible_wait_row", "Wait {n} min at {stop}")
          .replace("{n}", String(minutes))
          .replace("{stop}", stopName)}
      </span>
    </div>
  );
}
