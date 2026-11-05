import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  I18nContext,
  detectLanguage,
  loadLocale,
  loadPrivacyNamespace,
  type SupportedLocale,
  type Translations,
} from "./index.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";

export function I18nProvider({ children }: { children: ReactNode }) {
  const languageSetting = useSettingsStore((s) => s.language);
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [translations, setTranslations] = useState<Translations>({});
  // The privacy namespace is kept in its own map rather than merged into
  // `translations`. Both are refetched when the locale changes, and merging
  // would make the result order-dependent: whichever request settles last
  // would win, so a fast namespace fetch could be wiped by a slow base fetch.
  // Separate maps + lookup-time precedence removes the race entirely.
  const [privacyNs, setPrivacyNs] = useState<Translations>({});
  const [privacyRequested, setPrivacyRequested] = useState(false);
  const [privacyReady, setPrivacyReady] = useState(false);

  const resolved: SupportedLocale =
    languageSetting !== "auto"
      ? languageSetting
      : detectLanguage(navigator.language);

  useEffect(() => {
    let cancelled = false;
    loadLocale(resolved)
      .then((t) => {
        if (!cancelled) {
          setTranslations(t);
          setLocale(resolved);
        }
      })
      .catch(() => {
        if (!cancelled && resolved !== "en") {
          loadLocale("en")
            .then((t) => {
              if (!cancelled) {
                setTranslations(t);
                setLocale("en");
              }
            })
            .catch(() => {});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolved]);

  const ensurePrivacyNamespace = useCallback(() => {
    setPrivacyRequested(true);
  }, []);

  // Fetched only once some mounted consumer asks for it — see
  // usePrivacyNamespace(). Keyed on `resolved` so a language change refetches.
  useEffect(() => {
    if (!privacyRequested) return;
    let cancelled = false;
    setPrivacyReady(false);
    loadPrivacyNamespace(resolved)
      .then((ns) => {
        if (!cancelled) {
          setPrivacyNs(ns);
          setPrivacyReady(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [privacyRequested, resolved]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: string, fallback?: string): string =>
      privacyNs[key] ?? translations[key] ?? fallback ?? key,
    [translations, privacyNs]
  );

  // Use the full browser locale tag (e.g. "en-GB") for date/time formatting
  // when language is "auto"; otherwise use the selected locale.
  const formattingLocale =
    languageSetting === "auto" ? navigator.language : locale;

  const value = useMemo(
    () => ({
      locale,
      formattingLocale,
      t,
      privacyReady,
      ensurePrivacyNamespace,
    }),
    [locale, formattingLocale, t, privacyReady, ensurePrivacyNamespace]
  );

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}
