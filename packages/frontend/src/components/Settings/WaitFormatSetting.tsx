import { useTranslation } from "../../i18n/index.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";

/** Advanced: keep waits of an hour or more in minutes instead of h:mm. */
export function WaitFormatSetting() {
  const { t } = useTranslation();
  const minutesOnly = useSettingsStore((s) => s.waitMinutesOnly);
  const setMinutesOnly = useSettingsStore((s) => s.setWaitMinutesOnly);
  return (
    <section aria-labelledby="settings-wait-format-heading">
      <h2
        id="settings-wait-format-heading"
        className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2"
      >
        {t("settings.wait_format", "Waiting times")}
      </h2>
      <label className="flex items-center justify-between gap-3 px-4 py-3 min-h-11 bg-surface-raised rounded-xl border border-divider cursor-pointer">
        <span>
          <span id="settings-wait-minutes-label" className="text-sm text-fg block">
            {t("settings.wait_minutes_only", "Show waits in minutes only")}
          </span>
          <span id="settings-wait-minutes-desc" className="text-xs text-fg-muted block">
            {t("settings.wait_minutes_only_desc", "Otherwise a wait of an hour or more shows as hours and minutes, like 1:05.")}
          </span>
        </span>
        <input
          type="checkbox"
          className="accent-accent shrink-0 w-5 h-5"
          aria-labelledby="settings-wait-minutes-label"
          aria-describedby="settings-wait-minutes-desc"
          checked={minutesOnly}
          onChange={(e) => setMinutesOnly(e.target.checked)}
        />
      </label>
    </section>
  );
}
