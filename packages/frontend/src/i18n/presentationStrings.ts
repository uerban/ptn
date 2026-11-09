/**
 * Strings for Text mode, the temporary map, trip-start explanations and the
 * nearby lists, kept in their own namespace (`i18n/presentation.json`). A
 * locale overlay (`i18n/presentation.<locale>.json`) is picked up
 * automatically when present; a key it lacks falls back to the English
 * source.
 */
import english from "./presentation.json";
import { createStringNamespace, type NamespaceText } from "./stringNamespace.ts";

export type PresentationStringKey = keyof typeof english;
export type PresentationText = NamespaceText<PresentationStringKey>;

const namespace = createStringNamespace<PresentationStringKey>(
  english,
  import.meta.glob<{ default: Record<string, string> }>("./presentation.*.json"),
  (locale) => `./presentation.${locale}.json`,
);

export const formatPresentationText = namespace.format;
export const usePresentationText = namespace.useText;
