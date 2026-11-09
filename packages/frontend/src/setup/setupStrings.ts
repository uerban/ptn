/**
 * Strings for the setup shell, kept in their own namespace (`i18n/setup.json`)
 * so first-run copy ships only with the setup chunk. A locale overlay
 * (`i18n/setup.<locale>.json`) is picked up automatically when present; a
 * key it lacks falls back to the English source.
 */
import english from "../i18n/setup.json";
import { createStringNamespace, type NamespaceText } from "../i18n/stringNamespace.ts";

export type SetupStringKey = keyof typeof english;
export type SetupText = NamespaceText<SetupStringKey>;

const namespace = createStringNamespace<SetupStringKey>(
  english,
  import.meta.glob<{ default: Record<string, string> }>("../i18n/setup.*.json"),
  (locale) => `../i18n/setup.${locale}.json`,
);

export const formatSetupText = namespace.format;
export const useSetupText = namespace.useText;
