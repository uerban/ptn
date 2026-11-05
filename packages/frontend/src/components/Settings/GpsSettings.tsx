import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useTranslation } from "../../i18n/index.ts";

export function GpsSettings() {
  const { t } = useTranslation();
  const gpsMode = useSettingsStore((state) => state.gpsMode);
  const setGpsMode = useSettingsStore((state) => state.setGpsMode);
  const options = [
    ["enabled", t("gps.enabled", "While app is open")],
    ["until-locate", t("gps.until_locate", "Off until I tap Locate me")],
    ["disabled", t("gps.disabled", "Completely off")],
  ] as const;
  return (
    <section aria-labelledby="settings-gps-heading">
      <h2 id="settings-gps-heading" className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {t("gps.heading", "GPS location")}
      </h2>
      <div role="radiogroup" aria-labelledby="settings-gps-heading" aria-describedby="settings-gps-description"
        className="bg-surface-raised rounded-xl border border-divider">
        {options.map(([mode, label]) => (
          <label key={mode} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 cursor-pointer">
            <span className="text-sm text-fg">{label}</span>
            <input type="radio" name="gpsMode" value={mode} checked={gpsMode === mode}
              onChange={() => setGpsMode(mode)} className="accent-accent" />
          </label>
        ))}
      </div>
      <p id="settings-gps-description" className="text-xs text-fg-muted mt-2">
        {t("gps.description", "Location stays on this device. Completely off also disables GPS during navigation and the Locate me button. Stop alerts need the app visible; they cannot be guaranteed with the screen locked.")}
      </p>
    </section>
  );
}
