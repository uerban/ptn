import { useCityStore } from "../../stores/cityStore.ts";
import { BIKE_SHARE_FLOW, useBikeShareStore } from "../../stores/bikeShareStore.ts";
import { useTranslation } from "../../i18n/index.ts";

/**
 * Opt-in chip toggling the GBFS bike-share map layer (`ModeToggle` idiom).
 * Renders only for cities with a `sharedMobility` config entry; everywhere
 * else the map is byte-for-byte unaffected.
 *
 * PRIVACY: the chip starts OFF and merely rendering it fetches nothing —
 * the first tap is the user's explicit opt-in to contacting the operator
 * (`bikeShareStore.enable` performs the first request). State is
 * session-only, so there is never an auto-fetch on app start. The requests
 * are the registered `external.bike-share` flow, described in Settings.
 */
export function BikeShareToggle() {
  const { t } = useTranslation();
  const activeCity = useCityStore((s) => s.activeCity);
  const enabled = useBikeShareStore((s) => s.enabled);

  if (!activeCity.sharedMobility?.length) return null;

  const label = t("bikeShare.toggle", "Bike share");
  return (
    <button
      type="button"
      onClick={() => {
        const store = useBikeShareStore.getState();
        if (enabled) store.disable();
        else void store.enable(activeCity);
      }}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-raised
        rounded-full shadow-1
        text-xs font-medium transition-colors shrink-0"
      data-testid="bike-share-toggle"
      data-flow={BIKE_SHARE_FLOW}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">🚲</span>
      <span className={enabled ? "text-fg" : "text-fg-muted"}>
        {t("bikeShare.chip", "Bikes")}
      </span>
    </button>
  );
}
