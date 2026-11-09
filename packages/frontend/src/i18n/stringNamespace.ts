/**
 * A string namespace kept outside the main translation bundle: English ships
 * with the module that uses it, and a locale overlay loads on demand. A key the
 * overlay lacks falls back to the English source.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation, type SupportedLocale } from "./index.ts";
import { fill } from "./fill.ts";

type Overlay = Record<string, string>;
type OverlayLoaders = Record<string, () => Promise<{ default: Overlay }>>;

export type NamespaceText<K extends string> = (key: K, vars?: Record<string, string>) => string;

/**
 * `overlays` comes from `import.meta.glob` in the caller; `overlayPath` maps a
 * locale to its key in that record.
 */
export function createStringNamespace<K extends string>(
  english: Readonly<Record<K, string>>,
  overlays: OverlayLoaders,
  overlayPath: (locale: SupportedLocale) => string,
) {
  /** Locales whose overlay has already loaded, so a remount renders it at once. */
  const loaded = new Map<SupportedLocale, Overlay>();

  async function loadOverlay(locale: SupportedLocale): Promise<Overlay> {
    if (locale === "en") return {};
    const cached = loaded.get(locale);
    if (cached) return cached;
    const load = overlays[overlayPath(locale)];
    if (!load) return {};
    try {
      const overlay = (await load()).default;
      loaded.set(locale, overlay);
      return overlay;
    } catch {
      return {};
    }
  }

  function format(overlay: Readonly<Overlay>, key: K, vars: Record<string, string> = {}): string {
    return fill(overlay[key] ?? english[key] ?? key, vars);
  }

  function useText(): NamespaceText<K> {
    const { locale } = useTranslation();
    const [overlay, setOverlay] = useState<Overlay>(() => loaded.get(locale) ?? {});
    useEffect(() => {
      let cancelled = false;
      void loadOverlay(locale).then((next) => {
        if (!cancelled) setOverlay(next);
      });
      return () => {
        cancelled = true;
      };
    }, [locale]);
    return useMemo(() => (key: K, vars?: Record<string, string>) => format(overlay, key, vars), [overlay]);
  }

  return { format, useText };
}
