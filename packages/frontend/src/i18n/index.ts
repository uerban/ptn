import { createContext, useContext, useEffect } from "react";

export const SUPPORTED_LOCALES = [
  "en",
  "lt",
  "pl",
  "be",
  "ru",
  "uk",
  "lv",
  "et",
  "sv",
  "nb",
  "fi",
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type Translations = Record<string, string>;

export interface I18nContextValue {
  locale: SupportedLocale;
  formattingLocale: string;
  t: (key: string, fallback?: string) => string;
  /** True once the privacy namespace is resident for the active locale. */
  privacyReady: boolean;
  /** Idempotent request to fetch the privacy namespace. */
  ensurePrivacyNamespace: () => void;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  formattingLocale: "en",
  t: (key, fallback) => fallback ?? key,
  privacyReady: false,
  ensurePrivacyNamespace: () => {},
});

export function useTranslation() {
  return useContext(I18nContext);
}

/**
 * Opt into the lazily-fetched `privacy.*` namespace and report whether it is
 * resident yet.
 *
 * Most `privacy.*` keys are reached by template interpolation
 * (`privacy.axis.${axis}.title`) and so carry no inline English fallback —
 * they render as the raw key until the namespace lands. Components that show
 * such keys must gate their render on the returned flag.
 */
export function usePrivacyNamespace(): boolean {
  const { privacyReady, ensurePrivacyNamespace } = useContext(I18nContext);
  useEffect(() => {
    ensurePrivacyNamespace();
  }, [ensurePrivacyNamespace]);
  return privacyReady;
}

// Tags a browser reports that mean a locale PTN ships under another code.
// Norwegian is the one that bites: navigator.language is "no" on some
// browsers, "nb-NO" on others and "nn-NO" for Nynorsk users, and PTN ships
// Bokmål — which a Nynorsk reader reads without trouble, unlike English.
const LANGUAGE_ALIASES: Record<string, SupportedLocale> = {
  no: "nb",
  nn: "nb",
  nob: "nb",
};

export function detectLanguage(navigatorLang: string): SupportedLocale {
  const primary = navigatorLang.split("-")[0].toLowerCase();
  if (SUPPORTED_LOCALES.includes(primary as SupportedLocale)) {
    return primary as SupportedLocale;
  }
  return LANGUAGE_ALIASES[primary] ?? "en";
}

async function loadBaseLocale(locale: SupportedLocale): Promise<Translations> {
  switch (locale) {
    case "en": return (await import("./locales/en.json")).default;
    case "lt": return (await import("./locales/lt.json")).default;
    case "pl": return (await import("./locales/pl.json")).default;
    case "be": return (await import("./locales/be.json")).default;
    case "ru": return (await import("./locales/ru.json")).default;
    case "uk": return (await import("./locales/uk.json")).default;
    case "lv": return (await import("./locales/lv.json")).default;
    case "et": return (await import("./locales/et.json")).default;
    case "sv": return (await import("./locales/sv.json")).default;
    case "nb": return (await import("./locales/nb.json")).default;
    case "fi": return (await import("./locales/fi.json")).default;
    default: return (await import("./locales/en.json")).default;
  }
}

// Privacy namespace: per-locale JSON next to index.ts. A key absent from a
// locale file falls through to the English source-of-truth taxonomy (see
// the i18n key taxonomy notes) — which is how the files started
// life as near-empty stubs, and how a string DeepL could not render with its
// placeholders intact still displays.
//
// Deliberately NOT merged into loadLocale. The English source file is ~6 kB
// gzipped — larger than any single base locale chunk — and every non-English
// locale loads it in full because the per-locale files are near-empty stubs.
// Its consumers all sit behind the Settings/Privacy lazy boundary, so making
// every user pay it at boot bought nothing. Callers fetch it on demand via
// ensurePrivacyNamespace() in I18nProvider.
export async function loadPrivacyNamespace(
  locale: SupportedLocale,
): Promise<Translations> {
  const english = (await import("./privacy.json")).default as Translations;
  if (locale === "en") return english;
  let localeFile: Translations = {};
  switch (locale) {
    case "lt":
      localeFile = (await import("./privacy.lt.json")).default as Translations;
      break;
    case "pl":
      localeFile = (await import("./privacy.pl.json")).default as Translations;
      break;
    case "be":
      localeFile = (await import("./privacy.be.json")).default as Translations;
      break;
    case "ru":
      localeFile = (await import("./privacy.ru.json")).default as Translations;
      break;
    case "uk":
      localeFile = (await import("./privacy.uk.json")).default as Translations;
      break;
    case "lv":
      localeFile = (await import("./privacy.lv.json")).default as Translations;
      break;
    case "et":
      localeFile = (await import("./privacy.et.json")).default as Translations;
      break;
    case "sv":
      localeFile = (await import("./privacy.sv.json")).default as Translations;
      break;
    case "nb":
      localeFile = (await import("./privacy.nb.json")).default as Translations;
      break;
    case "fi":
      localeFile = (await import("./privacy.fi.json")).default as Translations;
      break;
  }
  return { ...english, ...localeFile };
}

export async function loadLocale(locale: SupportedLocale): Promise<Translations> {
  return loadBaseLocale(locale);
}
