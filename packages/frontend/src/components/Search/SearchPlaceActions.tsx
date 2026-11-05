import { Icon } from "../Icon.tsx";
import { useTranslation } from "../../i18n/index.ts";

export function LocationTargetIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
  </svg>;
}

/** Share the feedback row; the visual pills are small, with 44px touch targets. */
export function SearchPlaceActions({ onMap, onLocation, locationAvailable }: {
  onMap: () => void;
  onLocation: () => void;
  locationAvailable: boolean;
}) {
  const { t } = useTranslation();
  const target = "group inline-flex min-h-11 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const pill = "inline-flex items-center gap-1.5 rounded-full border border-divider/60 bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-fg-secondary transition-colors group-hover:bg-surface-overlay group-hover:text-accent";
  return <div className="flex shrink-0 items-center gap-1">
    <button type="button" onClick={onMap} className={target}
      aria-label={t("search.choose_on_map", "Choose on map")} title={t("search.choose_on_map", "Choose on map")}>
      <span className={pill}><Icon name="map" size={16} /><span>{t("nav.map", "Map")}</span></span>
    </button>
    {locationAvailable && <button type="button" onClick={onLocation} className={target}
      aria-label={t("search.use_current_location", "Use my current location")} title={t("search.use_current_location", "Use my current location")}>
      <span className={pill}><LocationTargetIcon /><span>{t("search.my_location", "My location")}</span></span>
    </button>}
  </div>;
}
