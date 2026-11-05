import type { SearchSuggestion } from "./searchSuggestions.ts";

// Georgian national romanization (2002), also used by OSM name:ka-Latn:
// https://wiki.openstreetmap.org/wiki/Key:name:ka-Latn
// Display-only fallback: authored alternate names take precedence. This does
// not change the search normalizer, matching, ranking, or the selected label.
const GEORGIAN = Object.fromEntries(
  [..."აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ"].map((letter, i) => [
    letter,
    ["a", "b", "g", "d", "e", "v", "z", "t", "i", "k’", "l", "m", "n", "o", "p’", "zh", "r", "s", "t’", "u", "p", "k", "gh", "q’", "sh", "ch", "ts", "dz", "ts’", "ch’", "kh", "j", "h"][i],
  ]),
);

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function romanizeGeorgian(text: string): string | undefined {
  if (!/\p{Script=Georgian}/u.test(text)) return undefined;
  const result = [...text].map((char) => GEORGIAN[char.toLowerCase()] ?? char).join("");
  // Do not present partially converted historical or mixed-script names as a
  // readable Latin fallback. Other scripts need their own reviewed support.
  return /[^\p{Script=Latin}\p{Mark}\p{Number}\p{Punctuation}\p{Separator}]/u.test(result)
    ? undefined
    : result;
}

/** Optional, display-only context. Never selects an arbitrary foreign alias. */
export function searchResultSubtext(suggestion: SearchSuggestion, locale: string): string | undefined {
  const label = suggestion.kind === "geocoded" ? suggestion.label : suggestion.name;
  const aliases = suggestion.kind === "geocoded" ? suggestion.aliases ?? {} : {};
  const language = locale.toLowerCase().split("-")[0];
  const aliasEntries = Object.entries(aliases);
  const localized = [locale.toLowerCase(), language]
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .flatMap((languageKey) => aliasEntries
      .filter(([key]) => key.toLowerCase() === languageKey)
      .flatMap(([, values]) => values));
  const latinNames = Object.entries(aliases)
    .filter(([key]) => /-latn(?:-|$)/i.test(key))
    .flatMap(([, values]) => values);
  const hasNonLatin = /\p{Letter}/u.test(label.replace(/\p{Script=Latin}/gu, ""));
  const candidates = [
    ...localized,
    ...(hasNonLatin ? [...latinNames, ...(aliases.en ?? [])] : []),
  ];
  const alternate = candidates.find((candidate) => candidate.trim() && normalized(candidate) !== normalized(label))?.trim()
    ?? (hasNonLatin ? romanizeGeorgian(label) : undefined);
  const address = suggestion.kind === "geocoded" ? suggestion.address : undefined;
  const street = [address?.street, address?.street ? address.houseNumber : undefined].filter(Boolean).join(" ");
  const parts = [alternate, street, address?.locality];
  const seen = new Set([normalized(label)]);
  const distinct = parts.filter((part): part is string => {
    if (!part?.trim() || seen.has(normalized(part))) return false;
    seen.add(normalized(part));
    return true;
  });
  return distinct.length ? distinct.join(" · ") : undefined;
}
