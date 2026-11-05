const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
};

const ARABIC_TO_LATIN: Record<string, string> = {
  ا: "a",
  أ: "a",
  إ: "i",
  آ: "a",
  ٱ: "a",
  ب: "b",
  ت: "t",
  ث: "th",
  ج: "j",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "dh",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ک: "k",
  گ: "g",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  ة: "a",
  و: "w",
  ؤ: "w",
  ي: "y",
  ی: "y",
  ى: "a",
  ئ: "y",
  ء: "",
};

const ADDRESS_TERM_SYNONYMS: Record<string, string> = {
  aikste: "aikste",
  square: "aikste",
  place: "aikste",
  ploshchad: "aikste",
  ploshad: "aikste",
  ploschad: "aikste",
  saha: "aikste",
  sahh: "aikste",
  gatve: "gatve",
  g: "gatve",
  street: "gatve",
  st: "gatve",
  ulitsa: "gatve",
  ulica: "gatve",
  shara: "gatve",
  prospektas: "prospektas",
  pr: "prospektas",
  avenue: "prospektas",
  ave: "prospektas",
  prospekt: "prospektas",
};

const CANONICAL_ADDRESS_TERMS = new Set(Object.values(ADDRESS_TERM_SYNONYMS));
const STEM_SUFFIXES = ["ijos", "iu", "os", "as", "is", "us", "ys", "es", "a", "e", "i"];

function transliterate(input: string, map: Record<string, string>): string {
  let out = "";
  for (const ch of input) out += map[ch] ?? ch;
  return out;
}

function uniqueNonEmpty(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function tokensOf(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

function replaceAddressTerms(text: string): string {
  return tokensOf(text)
    .map((token) => ADDRESS_TERM_SYNONYMS[token] ?? token)
    .join(" ");
}

function stemAddressToken(token: string): string {
  if (CANONICAL_ADDRESS_TERMS.has(token) || /^\d+[a-z]?$/.test(token)) return token;
  for (const suffix of STEM_SUFFIXES) {
    if (token.length - suffix.length < 5) continue;
    if (token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

function stemAddressPhrase(text: string): string {
  return tokensOf(text).map(stemAddressToken).join(" ");
}

function addSignificantSuffixKeys(keys: Set<string>, tokens: string[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (CANONICAL_ADDRESS_TERMS.has(token)) continue;
    if (/^\d/.test(token) || token.length < 3) continue;
    keys.add(tokens.slice(i).join(" "));
  }
}

/** Moves a leading address term to the end of the phrase.
 *
 * Slavic word order puts the generic term first (`площадь Кудирки`,
 * `улица Гедимино`) while Lithuanian and Polish labels put it last
 * (`Kudirkos aikštė`). This rotation is applied to the QUERY, so a term-first
 * query reaches the term-last keys the corpus already stores.
 *
 * It used to be a build-time expansion instead (`addAddressTermFirstKeys`,
 * one stored key per row). That cost 126,317 keys and 1.71 MB of FST on
 * vilnius — 26% of the keys for 39% of the bytes, because each alias started
 * at a canonical term and then re-ordered the whole street name, so it shared
 * almost no prefix with anything. Rotating one query instead costs nothing.
 * Returns the input unchanged when there is no leading term to move.
 */
function rotateLeadingAddressTerm(text: string): string {
  const tokens = tokensOf(text);
  if (tokens.length < 2) return text;
  if (!CANONICAL_ADDRESS_TERMS.has(tokens[0]!)) return text;

  // The term lands after the NAME tokens but BEFORE any house number, because
  // that is where the labels put it: `проспект Гедимино 23` has to become
  // `gedimino prospektas 23`, not `gedimino 23 prospektas`. Appending to the
  // very end silently returns zero results for every numbered term-first query.
  const rest = tokens.slice(1);
  const firstNumber = rest.findIndex((token) => /^\d/.test(token));
  if (firstNumber < 0) return [...rest, tokens[0]!].join(" ");
  return [...rest.slice(0, firstNumber), tokens[0]!, ...rest.slice(firstNumber)].join(" ");
}

/** Normalizes text for local address search.
 *
 * This is intentionally narrower than a full geocoder: Latin diacritic folding,
 * Cyrillic transliteration, Arabic-script transliteration, ASCII tokenization,
 * and whitespace collapse. Address-term synonyms and token-prefix expansion are
 * separate steps so callers can inspect the base normalized form in tests.
 */
export function normalizeAddressSearchText(input: string): string {
  const lower = input.toLowerCase();
  const transliterated = transliterate(
    transliterate(lower, CYRILLIC_TO_LATIN),
    ARABIC_TO_LATIN,
  );
  return transliterated
    .replace(/\u0142/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns normalized query prefixes to try against the address FST.
 *
 * The list includes the base normalized query, address-term synonym replacement,
 * and a conservative suffix-folded form for cases like `Kudirkos` / `Kudirki`.
 */
export function addressSearchQueryVariants(query: string): string[] {
  const base = normalizeAddressSearchText(query);
  const synonym = replaceAddressTerms(base);
  // Rotation runs on the SYNONYM form, not the base: `площадь` has to become
  // `aikste` before we can recognize it as a leading address term at all.
  const rotated = rotateLeadingAddressTerm(synonym);
  return uniqueNonEmpty([
    base,
    synonym,
    stemAddressPhrase(base),
    stemAddressPhrase(synonym),
    rotated,
    stemAddressPhrase(rotated),
  ]);
}

/** Builds FST keys for one display label.
 *
 * The display label must stay locale-correct elsewhere. These keys are lookup
 * material only: full label form, significant-token suffixes, and their
 * conservative suffix-folded variants.
 *
 * Deliberately narrower than the query variants: term-first word order is
 * handled by rotating the QUERY (`rotateLeadingAddressTerm`), not by storing a
 * reordered alias per row. The label expansion iterates the base and synonym
 * forms only — a rotated LABEL would store the same 1.71 MB of low-sharing
 * keys the build-time alias used to.
 */
export function buildAddressSearchKeys(label: string): string[] {
  const keys = new Set<string>();
  const base = normalizeAddressSearchText(label);
  const synonym = replaceAddressTerms(base);
  const labelVariants = uniqueNonEmpty([
    base,
    synonym,
    stemAddressPhrase(base),
    stemAddressPhrase(synonym),
  ]);
  for (const variant of labelVariants) {
    keys.add(variant);
    addSignificantSuffixKeys(keys, tokensOf(variant));
  }
  return uniqueNonEmpty(keys);
}
