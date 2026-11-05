import { useState } from "react";
import {
  useTranslation,
  detectLanguage,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../../i18n/index.ts";
import {
  useSettingsStore,
  type LanguageSetting,
} from "../../stores/settingsStore.ts";

/**
 * Language names are endonyms on purpose: a user whose language was detected
 * wrongly cannot read the surrounding UI, so the only thing that lets them
 * find their own language is seeing it written the way they write it.
 */
const LANGUAGE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  lt: "Lietuvių",
  pl: "Polski",
  be: "Беларуская",
  ru: "Русский",
  uk: "Українська",
  lv: "Latviešu",
  et: "Eesti",
  sv: "Svenska",
  nb: "Norsk bokmål",
  fi: "Suomi",
};

const HEADING_ID = "settings-language-heading";

export function LanguagePicker() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const [expanded, setExpanded] = useState(false);

  // A flat radio row per locale ran to seven rows and grew with every
  // language added — most of a phone viewport for a setting whose default is
  // already correct for nearly everyone. Show only the options a user
  // plausibly wants, and keep the rest one tap away rather than hidden: the
  // full list still renders in this same group, under the same endonyms.
  const detected = detectLanguage(navigator.language);
  const primary: LanguageSetting[] = [];
  for (const option of [
    "auto",
    detected,
    language,
    "en",
  ] as LanguageSetting[]) {
    if (!primary.includes(option)) primary.push(option);
  }

  const rest = SUPPORTED_LOCALES.filter((l) => !primary.includes(l));
  const shown: LanguageSetting[] = expanded ? [...primary, ...rest] : primary;

  return (
    <section>
      <h2
        id={HEADING_ID}
        className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-2"
      >
        {t("settings.language", "Language")}
      </h2>
      <div
        role="radiogroup"
        aria-labelledby={HEADING_ID}
        className="bg-surface-raised rounded-xl border border-divider"
      >
        {shown.map((lang) => (
          <label
            key={lang}
            className="flex items-center justify-between px-4 py-3
              border-b border-divider last:border-b-0 cursor-pointer"
          >
            <span className="text-sm text-fg">
              {lang === "auto"
                ? t("settings.language_auto", "Auto-detect")
                : LANGUAGE_LABELS[lang]}
            </span>
            <input
              type="radio"
              name="language"
              value={lang}
              checked={language === lang}
              onChange={() => setLanguage(lang)}
              className="accent-accent"
            />
          </label>
        ))}
      </div>
      {rest.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-fg-muted underline underline-offset-2"
        >
          {expanded
            ? t("settings.language_fewer", "Fewer languages")
            : t("settings.language_more", "More languages ({count})").replace(
                "{count}",
                String(rest.length),
              )}
        </button>
      )}
    </section>
  );
}
