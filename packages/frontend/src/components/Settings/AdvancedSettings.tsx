import { LOOSE_POI_CATEGORIES, LOOSE_POI_CATEGORY_LABELS } from "../../config/poiCategories.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useTranslation } from "../../i18n/index.ts";

export function AdvancedSettings() {
  const { t } = useTranslation();
  const {
    preferredAdapter, setPreferredAdapter,
    maxPopupLines, setMaxPopupLines,
    poiLooseCategories, setPoiLooseCategories,
  } = useSettingsStore();

  const engines = [
    { value: "raptor", label: "RAPTOR (on-device)", desc: "Privacy-first, runs locally using synced GTFS data", available: true },
    { value: "motis", label: "MOTIS (Transitous)", desc: "Fast, global coverage via Transitous API", available: true },
    { value: "otp", label: "OpenTripPlanner", desc: "Mature engine, broad format support", available: false },
    { value: "navitia", label: "Navitia", desc: "Production-grade, European focus", available: false },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
          {t("settings.routing_engine", "Routing Engine")}
        </h2>
        <div className="bg-surface-raised rounded-xl border border-divider">
          {engines.map((engine) => (
            <label
              key={engine.value}
              className={`flex items-center justify-between px-4 py-3
                border-b border-divider last:border-b-0
                ${engine.available ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
            >
              <div>
                <div className="text-sm text-fg">
                  {engine.label}
                  {!engine.available && (
                    <span className="ml-2 text-xs text-fg-muted italic">
                      {t("settings.coming_soon", "Coming soon")}
                    </span>
                  )}
                </div>
                <div className="text-xs text-fg-muted">{engine.desc}</div>
              </div>
              <input
                type="radio"
                name="adapter"
                value={engine.value}
                checked={preferredAdapter === engine.value}
                onChange={() => setPreferredAdapter(engine.value)}
                disabled={!engine.available}
                className="accent-accent"
              />
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
          {t("settings.max_popup_lines", "Max lines in popup")}
        </h2>
        <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-fg">{maxPopupLines}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMaxPopupLines(maxPopupLines - 1)}
              disabled={maxPopupLines <= 2}
              className="w-8 h-8 rounded-lg bg-surface-overlay text-fg font-bold disabled:opacity-30"
            >−</button>
            <button
              onClick={() => setMaxPopupLines(maxPopupLines + 1)}
              disabled={maxPopupLines >= 8}
              className="w-8 h-8 rounded-lg bg-surface-overlay text-fg font-bold disabled:opacity-30"
            >+</button>
          </div>
        </div>
      </section>

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

    </div>
  );
}
