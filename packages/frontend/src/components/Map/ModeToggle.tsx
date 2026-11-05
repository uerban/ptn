import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useTranslation } from "../../i18n/index.ts";

export function ModeToggle() {
  const { t } = useTranslation();
  const urbanMode = useSettingsStore((s) => s.urbanMode);
  const urbanLookaheadHours = useSettingsStore((s) => s.urbanLookaheadHours);
  const setUrbanMode = useSettingsStore((s) => s.setUrbanMode);

  // The "h" suffix is a word in most locales ("2 гадз", "2 t", "2 tim"), not a
  // unit symbol that survives translation — so the whole token is one key.
  const lookahead = t("map.mode_lookahead_hours", "{hours}h").replace(
    "{hours}",
    String(urbanLookaheadHours),
  );

  return (
    <button
      onClick={() => setUrbanMode(!urbanMode)}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-raised
        rounded-full shadow-1
        text-xs font-medium transition-colors shrink-0"
      data-testid="mode-toggle"
      aria-label={
        urbanMode
          ? `${t("map.mode_now", "Now")} · ${lookahead}`
          : t("map.mode_all", "All")
      }
    >
      {urbanMode ? (
        <>
          <span className="w-1.5 h-1.5 bg-success rounded-full" />
          <span className="text-fg">
            {t("map.mode_now", "Now")}
            <span className="text-fg-muted ml-1">· {lookahead}</span>
          </span>
        </>
      ) : (
        <span className="text-fg-muted">{t("map.mode_all", "All")}</span>
      )}
    </button>
  );
}
