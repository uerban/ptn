/**
 * Strings for Text mode, the temporary map, trip-start explanations and the
 * nearby lists, kept in their own namespace (`i18n/presentation.json`). A
 * locale overlay (`i18n/presentation.<locale>.json`) is picked up
 * automatically when present; a key it lacks falls back to the English
 * source.
 */
import { useEffect, useMemo, useState } from "react";
import english from "./presentation.json";
import { useTranslation, type SupportedLocale } from "./index.ts";
import { fill } from "./fill.ts";

export type PresentationStringKey = keyof typeof english;
export type PresentationText = (
  key: PresentationStringKey,
  vars?: Record<string, string>,
) => string;

const OVERLAYS = import.meta.glob<{ default: Record<string, string> }>(
  "./presentation.*.json",
);

/** Locales whose overlay has already loaded, so a remount renders it at once. */
const loaded = new Map<SupportedLocale, Record<string, string>>();

async function loadOverlay(locale: SupportedLocale): Promise<Record<string, string>> {
  if (locale === "en") return {};
  const cached = loaded.get(locale);
  if (cached) return cached;
  const load = OVERLAYS[`./presentation.${locale}.json`];
  if (!load) return {};
  try {
    const overlay = (await load()).default;
    loaded.set(locale, overlay);
    return overlay;
  } catch {
    return {};
  }
}

export function formatPresentationText(
  overlay: Readonly<Record<string, string>>,
  key: PresentationStringKey,
  vars: Record<string, string> = {},
): string {
  return fill(overlay[key] ?? english[key] ?? key, vars);
}

export function usePresentationText(): PresentationText {
  const { locale } = useTranslation();
  const [overlay, setOverlay] = useState<Record<string, string>>(
    () => loaded.get(locale) ?? {},
  );
  useEffect(() => {
    let cancelled = false;
    void loadOverlay(locale).then((next) => {
      if (!cancelled) setOverlay(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);
  return useMemo(
    () => (key: PresentationStringKey, vars?: Record<string, string>) =>
      formatPresentationText(overlay, key, vars),
    [overlay],
  );
}
