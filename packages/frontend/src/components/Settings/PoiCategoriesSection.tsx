import { LOOSE_POI_CATEGORIES, LOOSE_POI_CATEGORY_LABELS } from "../../config/poiCategories.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useTranslation } from "../../i18n/index.ts";

/** Which optional kinds of places search includes. Lives with the Search
 *  settings: it changes what a place search can find. */
export function PoiCategoriesSection() {
  const { t } = useTranslation();
  const { poiLooseCategories, setPoiLooseCategories } = useSettingsStore();

  return (
    <section>
      <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {t("settings.poi_data", "POI Data")}
      </h2>
      <p className="text-xs text-fg-muted mb-2">
        {t("settings.poi_categories_desc", "Choose additional places to include in search. Landmarks are always included. Choices stay on this device.")}
      </p>
      <div className="bg-surface-raised rounded-xl border border-divider">
        {LOOSE_POI_CATEGORIES.map((category) => (
          <label key={category} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 cursor-pointer">
            <span className="text-sm text-fg">{t(`settings.poi_category.${category}`, LOOSE_POI_CATEGORY_LABELS[category])}</span>
            <input
              type="checkbox"
              checked={poiLooseCategories.includes(category)}
              onChange={(e) => setPoiLooseCategories(e.target.checked
                ? [...poiLooseCategories, category]
                : poiLooseCategories.filter((selected) => selected !== category))}
              className="accent-accent"
            />
          </label>
        ))}
      </div>
    </section>
  );
}
