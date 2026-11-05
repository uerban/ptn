import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useTranslation } from "../../i18n/index.ts";

/** Four temporary choices while we validate Search on real phone keyboards. */
export function SearchLayoutSettings() {
  const settings = useSettingsStore();
  const { t } = useTranslation();
  const choices = [
    { key: "field", title: t("settings.search_active_field", "Show only the active field"), description: t("settings.search_active_field_desc", "Turn off to keep both journey fields visible while choosing a place."), value: settings.searchActiveFieldOnly, set: settings.setSearchActiveFieldOnly },
    { key: "keyboard", title: t("settings.search_keyboard_fit", "Fit search above the keyboard"), description: t("settings.search_keyboard_fit_desc", "Fit the picker to the visible screen and hide bottom navigation while choosing a place."), value: settings.searchKeyboardFit, set: settings.setSearchKeyboardFit },
    { key: "rows", title: t("settings.search_compact_rows", "Compact suggestion rows"), description: t("settings.search_compact_rows_desc", "Turn off for more space between suggestions."), value: settings.searchCompactRows, set: settings.setSearchCompactRows },
    { key: "scroll", title: t("settings.search_dismiss_scroll", "Dismiss keyboard on scroll"), description: t("settings.search_dismiss_scroll_desc", "Close the keyboard when scrolling place suggestions or saved items."), value: settings.searchDismissOnScroll, set: settings.setSearchDismissOnScroll },
  ];
  return <section aria-labelledby="settings-search-layout-heading">
    <h2 id="settings-search-layout-heading" className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">{t("settings.search_layout", "Search layout · temporary options")}</h2>
    <div className="bg-surface-raised rounded-xl border border-divider">
      {choices.map(choice => <label key={choice.key} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 cursor-pointer">
        <span><span className="text-sm text-fg block">{choice.title}</span><span className="text-xs text-fg-muted block">{choice.description}</span></span>
        <input type="checkbox" className="accent-accent shrink-0" aria-label={choice.title} checked={choice.value} onChange={event => choice.set(event.target.checked)} />
      </label>)}
    </div>
  </section>;
}
