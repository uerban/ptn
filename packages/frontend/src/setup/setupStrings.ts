/**
 * Strings for the setup shell, kept in their own namespace (`i18n/setup.json`)
 * so first-run copy ships only with the setup chunk. A locale overlay
 * (`i18n/setup.<locale>.json`) is picked up automatically when present; a
 * key it lacks falls back to the English source.
 */
import { useEffect, useMemo, useState } from "react";
import english from "../i18n/setup.json";
import { useTranslation, type SupportedLocale } from "../i18n/index.ts";

export type SetupStringKey = keyof typeof english;
export type SetupText = (key: SetupStringKey, vars?: Record<string, string>) => string;

const OVERLAYS = import.meta.glob<{ default: Record<string, string> }>(
  "../i18n/setup.*.json",
);

export async function loadSetupOverlay(
  locale: SupportedLocale,
): Promise<Record<string, string>> {
  if (locale === "en") return {};
  const load = OVERLAYS[`../i18n/setup.${locale}.json`];
  if (!load) return {};
  try {
    return (await load()).default;
  } catch {
    return {};
  }
}

export function formatSetupText(
  overlay: Readonly<Record<string, string>>,
  key: SetupStringKey,
  vars: Record<string, string> = {},
): string {
  const template = overlay[key] ?? english[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? vars[name] : match,
  );
}

export function useSetupText(): SetupText {
  const { locale } = useTranslation();
  const [overlay, setOverlay] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void loadSetupOverlay(locale).then((next) => {
      if (!cancelled) setOverlay(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);
  return useMemo(
    () => (key: SetupStringKey, vars?: Record<string, string>) =>
      formatSetupText(overlay, key, vars),
    [overlay],
  );
}
