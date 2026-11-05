//! `pt-geocode` — FST-backed single-bundle address index.
//!
//! The index stores display rows separately from lookup keys. The FST maps
//! normalized search keys to row ids; public matches return the original display
//! label and coordinates. Internally, keys are encoded as
//! `<lookup-key>\0<zero-padded-row-id>` so `fst::Map` can hold several rows for
//! the same lookup key while still serving prefix scans.

use std::collections::HashSet;
use std::sync::Arc;

use fst::{IntoStreamer, Map, MapBuilder, Streamer};
use unicode_normalization::UnicodeNormalization;

pub mod artifact;
pub use artifact::{ArtifactError, ArtifactMeta, SCHEMA_VERSION};

const KEY_ROW_SEPARATOR: char = '\0';
const STEM_SUFFIXES: &[&str] = &[
    "ijos", "iu", "os", "as", "is", "us", "ys", "es", "a", "e", "i",
];

#[derive(Clone, Debug, PartialEq)]
pub struct AddrRow {
    pub label: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddrKey {
    pub key: String,
    pub row_id: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AddrMatch {
    pub key: String,
    pub row_id: usize,
    pub label: String,
    pub lat: f64,
    pub lon: f64,
}

/// A loaded address index.
///
/// Backed by a packed [`artifact`] buffer: the `fst::Map` reads its bytes in
/// place out of that buffer and the row table and labels are decoded on demand,
/// so loading is a header parse plus a bounds check rather than a deserialize.
/// [`AddrIndex::build`] exists for tests and for the packer, and goes through
/// exactly the same path — pack, then load — so there is only ever one
/// in-memory representation to reason about.
pub struct AddrIndex {
    map: Map<artifact::Section>,
    rows: artifact::RowStore,
    meta: ArtifactMeta,
    key_count: usize,
    fst_size_bytes: usize,
}

#[derive(Debug)]
pub struct BuildError(String);

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "pt-geocode build error: {}", self.0)
    }
}

impl std::error::Error for BuildError {}

/// Number of decimal digits needed to write any row id in a corpus of
/// `row_count` rows, minimum 1.
///
/// The width has to be uniform within one artifact so that entries sharing a
/// key string sort deterministically; it does NOT have to be uniform across
/// artifacts, because nothing outside the FST reads it — `decode_lookup_key`
/// splits at the NUL separator and never looks at the digits.
fn row_id_width(row_count: usize) -> usize {
    let mut width = 1;
    let mut bound = 10;
    while row_count > bound {
        width += 1;
        bound *= 10;
    }
    width
}

/// Encode one FST key as `<lookup-key>\0<row-id>`.
///
/// `fst::Map` requires unique keys, and several rows legitimately share a
/// lookup key (`Gedimino pr. 9` and `9A` both normalize under
/// `gedimino prospektas 9`), so the row id disambiguates. It sits after a NUL
/// so it can never affect a prefix scan of the key itself.
///
/// The width is sized to the corpus rather than fixed. It used to be a flat 10
/// digits, which cost 11 bytes of suffix on every one of vilnius's 361 791
/// entries — the least compressible part of the FST, since suffixes sit where
/// prefix sharing is worst. Vilnius needs 5.
fn encode_fst_key(key: &str, row_id: usize, width: usize) -> String {
    format!("{key}{KEY_ROW_SEPARATOR}{row_id:0width$}")
}

fn decode_lookup_key(encoded: &[u8]) -> String {
    let key = encoded.split(|b| *b == 0).next().unwrap_or(encoded);
    String::from_utf8_lossy(key).into_owned()
}

fn cyrillic_to_latin(ch: char) -> Option<&'static str> {
    Some(match ch {
        'а' => "a",
        'б' => "b",
        'в' => "v",
        'г' => "g",
        'д' => "d",
        'е' | 'ё' | 'э' => "e",
        'ж' => "zh",
        'з' => "z",
        'и' | 'й' | 'і' => "i",
        'к' => "k",
        'л' => "l",
        'м' => "m",
        'н' => "n",
        'о' => "o",
        'п' => "p",
        'р' => "r",
        'с' => "s",
        'т' => "t",
        'у' => "u",
        'ф' => "f",
        'х' => "kh",
        'ц' => "ts",
        'ч' => "ch",
        'ш' => "sh",
        'щ' => "shch",
        'ъ' | 'ь' => "",
        'ы' => "y",
        'ю' => "yu",
        'я' => "ya",
        'ї' => "yi",
        'є' => "ye",
        'ґ' => "g",
        _ => return None,
    })
}

fn arabic_to_latin(ch: char) -> Option<&'static str> {
    Some(match ch {
        'ا' | 'أ' | 'آ' | 'ٱ' | 'ع' | 'ة' | 'ى' => "a",
        'إ' => "i",
        'ب' => "b",
        'ت' => "t",
        'ث' => "th",
        'ج' => "j",
        'ح' => "h",
        'خ' => "kh",
        'د' => "d",
        'ذ' => "dh",
        'ر' => "r",
        'ز' => "z",
        'س' | 'ص' => "s",
        'ش' => "sh",
        'ض' => "d",
        'ط' => "t",
        'ظ' => "z",
        'غ' => "gh",
        'ف' => "f",
        'ق' => "q",
        'ك' | 'ک' => "k",
        'گ' => "g",
        'ل' => "l",
        'م' => "m",
        'ن' => "n",
        'ه' => "h",
        'و' | 'ؤ' => "w",
        'ي' | 'ی' | 'ئ' => "y",
        'ء' => "",
        _ => return None,
    })
}

fn address_term_synonym(token: &str) -> Option<&'static str> {
    Some(match token {
        "aikste" | "square" | "place" | "ploshchad" | "ploshad" | "ploschad" | "saha" | "sahh" => {
            "aikste"
        }
        "gatve" | "g" | "street" | "st" | "ulitsa" | "ulica" | "shara" => "gatve",
        "prospektas" | "pr" | "avenue" | "ave" | "prospekt" => "prospektas",
        _ => return None,
    })
}

fn is_canonical_address_term(token: &str) -> bool {
    matches!(token, "aikste" | "gatve" | "prospektas")
}

fn tokens_of(text: &str) -> impl Iterator<Item = &str> {
    text.split(' ').filter(|token| !token.is_empty())
}

fn unique_non_empty(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
            continue;
        }
        out.push(trimmed);
    }
    out
}

fn replace_address_terms(text: &str) -> String {
    tokens_of(text)
        .map(|token| address_term_synonym(token).unwrap_or(token))
        .collect::<Vec<_>>()
        .join(" ")
}

/// True for a token matching `/^\d+[a-z]?$/`: one-or-more ASCII digits
/// followed by an optional single trailing ASCII lowercase letter, and
/// nothing else. Must stay byte-identical to the TypeScript normalizer's
/// guard in `packages/shared/src/addressSearch/normalizer.ts` — a token like
/// "12a3" does NOT match (extra trailing chars after the one optional
/// letter), so it falls through to suffix stemming like any other token.
fn is_numeric_token(token: &str) -> bool {
    let mut chars = token.chars();
    let mut digit_count = 0;
    let mut trailing = None;
    for ch in chars.by_ref() {
        if ch.is_ascii_digit() {
            digit_count += 1;
        } else {
            trailing = Some(ch);
            break;
        }
    }
    if digit_count == 0 {
        return false;
    }
    match trailing {
        None => true,
        Some(ch) => ch.is_ascii_lowercase() && chars.next().is_none(),
    }
}

fn stem_address_token(token: &str) -> String {
    if is_canonical_address_term(token) || is_numeric_token(token) {
        return token.to_string();
    }
    for suffix in STEM_SUFFIXES {
        if token.len().saturating_sub(suffix.len()) < 5 {
            continue;
        }
        if let Some(stemmed) = token.strip_suffix(suffix) {
            return stemmed.to_string();
        }
    }
    token.to_string()
}

fn stem_address_phrase(text: &str) -> String {
    tokens_of(text)
        .map(stem_address_token)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Moves a leading address term to the end of the phrase.
///
/// Slavic word order puts the generic term first (`площадь Кудирки`,
/// `улица Гедимино`) while Lithuanian and Polish labels put it last
/// (`Kudirkos aikštė`). Rotating the QUERY reaches the term-last keys the
/// corpus already stores, which is why the corpus no longer carries a
/// term-first alias per row.
///
/// Must stay byte-identical to `rotateLeadingAddressTerm` in
/// `packages/shared/src/addressSearch/normalizer.ts`.
fn rotate_leading_address_term(text: &str) -> String {
    let tokens: Vec<&str> = tokens_of(text).collect();
    if tokens.len() < 2 || !is_canonical_address_term(tokens[0]) {
        return text.to_string();
    }
    // The term lands after the NAME tokens but BEFORE any house number, because
    // that is where the labels put it: `проспект Гедимино 23` has to become
    // `gedimino prospektas 23`, not `gedimino 23 prospektas`. Appending to the
    // very end silently returns zero results for every numbered term-first query.
    let rest = &tokens[1..];
    let split = rest
        .iter()
        .position(|token| token.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(rest.len());
    let mut rotated: Vec<&str> = rest[..split].to_vec();
    rotated.push(tokens[0]);
    rotated.extend_from_slice(&rest[split..]);
    rotated.join(" ")
}

/// Normalizes text for local address search.
///
/// This mirrors the TypeScript normalizer in `@pt/shared/address-search`:
/// lowercase, Cyrillic and Arabic-script transliteration, Latin diacritic
/// folding, ASCII tokenization, and whitespace collapse.
pub fn normalize_address_search_text(input: &str) -> String {
    let mut transliterated = String::new();
    for ch in input.to_lowercase().chars() {
        if let Some(rep) = cyrillic_to_latin(ch).or_else(|| arabic_to_latin(ch)) {
            transliterated.push_str(rep);
        } else if ch == '\u{0142}' {
            transliterated.push('l');
        } else {
            transliterated.push(ch);
        }
    }

    let mut out = String::new();
    let mut last_was_space = true;
    for ch in transliterated.nfd() {
        // Matches the TypeScript normalizer's `[̀-ͯ]` combining-mark
        // strip exactly — the "Combining Diacritical Marks" block only, NOT
        // `unicode_normalization::char::is_combining_mark` (full
        // General_Category=Mark, e.g. Arabic tashkeel, Hebrew niqqud). Marks
        // outside this block fall through to the alphanumeric check below and
        // get collapsed to a space by the `else` branch, same as TS's
        // follow-up `[^a-z0-9]+` replace.
        if ('\u{0300}'..='\u{036f}').contains(&ch) {
            continue;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    out.trim().to_string()
}

/// Returns normalized query prefixes to try against the FST.
///
/// Includes the base normalized query, address-term synonym replacement, and a
/// conservative suffix-folded form for cases like `Kudirkos` / `Kudirki`.
pub fn address_search_query_variants(query: &str) -> Vec<String> {
    let base = normalize_address_search_text(query);
    let synonym = replace_address_terms(&base);
    // Rotation runs on the SYNONYM form, not the base: `площадь` has to become
    // `aikste` before it is recognizable as a leading address term at all.
    let rotated = rotate_leading_address_term(&synonym);
    unique_non_empty([
        base.clone(),
        synonym.clone(),
        stem_address_phrase(&base),
        stem_address_phrase(&synonym),
        rotated.clone(),
        stem_address_phrase(&rotated),
    ])
}

impl std::fmt::Debug for AddrIndex {
    /// Deliberately terse: the interesting state is a multi-megabyte FST and a
    /// label blob, and a test that dumps them on failure is unreadable.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddrIndex")
            .field("rows", &self.rows.len())
            .field("keys", &self.key_count)
            .field("fstBytes", &self.fst_size_bytes)
            .finish()
    }
}

impl AddrIndex {
    /// Builds an address index from display rows and normalized lookup keys.
    ///
    /// `AddrKey.row_id` must point into `rows`. Duplicate `(key, row_id)` pairs
    /// are ignored; identical keys pointing at different rows are preserved.
    /// Every row must be reachable by at least one key — an orphaned row is a
    /// corpus bug (e.g. a dedup collision) and is rejected the same way an
    /// out-of-range `row_id` is, rather than silently shipped as dead weight
    /// in the bundle.
    /// Encode rows + keys into a packed artifact.
    pub fn pack(
        rows: &[AddrRow],
        keys: &[AddrKey],
        meta: &ArtifactMeta,
    ) -> Result<Vec<u8>, BuildError> {
        let width = row_id_width(rows.len());
        let mut encoded: Vec<(String, usize)> = Vec::with_capacity(keys.len());
        let mut referenced_rows: HashSet<usize> = HashSet::new();
        for key in keys {
            if key.key.is_empty() {
                continue;
            }
            if key.row_id >= rows.len() {
                return Err(BuildError(format!(
                    "key {:?} points at row {} but only {} row(s) exist",
                    key.key,
                    key.row_id,
                    rows.len()
                )));
            }
            referenced_rows.insert(key.row_id);
            encoded.push((encode_fst_key(&key.key, key.row_id, width), key.row_id));
        }

        if let Some(orphan_id) = (0..rows.len()).find(|id| !referenced_rows.contains(id)) {
            return Err(BuildError(format!(
                "row {orphan_id} ({:?}) has no key pointing at it",
                rows[orphan_id].label
            )));
        }

        encoded.sort_by(|a, b| a.0.cmp(&b.0));
        encoded.dedup_by(|a, b| a.0 == b.0);

        let mut builder = MapBuilder::memory();
        for (encoded_key, row_id) in &encoded {
            builder
                .insert(encoded_key, *row_id as u64)
                .map_err(|e| BuildError(e.to_string()))?;
        }
        let fst_bytes = builder
            .into_inner()
            .map_err(|e| BuildError(e.to_string()))?;

        let labels: Vec<&str> = rows.iter().map(|r| r.label.as_str()).collect();
        let coords: Vec<(f64, f64)> = rows.iter().map(|r| (r.lat, r.lon)).collect();
        Ok(artifact::encode(
            &fst_bytes,
            &labels,
            &coords,
            encoded.len(),
            meta,
        ))
    }

    /// Build an index directly from rows and keys.
    ///
    /// Packs and then loads, so tests and callers exercise the same bytes and
    /// the same reader production does. Prefer [`AddrIndex::pack`] +
    /// [`AddrIndex::from_bytes`] when the artifact is going to disk anyway.
    pub fn build(rows: &[AddrRow], keys: &[AddrKey]) -> Result<Self, BuildError> {
        let bytes = Self::pack(rows, keys, &ArtifactMeta::default())?;
        Self::from_bytes(Arc::from(bytes.into_boxed_slice()))
            .map_err(|e| BuildError(format!("packed artifact failed to load back: {e}")))
    }

    /// Load an index from packed artifact bytes.
    ///
    /// The `Arc` is retained: the `fst::Map` and every label read borrow out of
    /// it, so nothing here copies the corpus.
    pub fn from_bytes(bytes: Arc<[u8]>) -> Result<Self, ArtifactError> {
        let parsed = artifact::parse(bytes)?;
        let map = Map::new(parsed.map_section).map_err(|e| ArtifactError::Fst(e.to_string()))?;
        Ok(AddrIndex {
            map,
            rows: parsed.rows,
            meta: parsed.meta,
            key_count: parsed.key_count,
            fst_size_bytes: parsed.fst_size_bytes,
        })
    }

    /// Size in bytes of the serialized FST section only.
    pub fn size_bytes(&self) -> usize {
        self.fst_size_bytes
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Number of distinct encoded keys the FST holds.
    pub fn key_count(&self) -> usize {
        self.key_count
    }

    pub fn meta(&self) -> &ArtifactMeta {
        &self.meta
    }

    pub fn prefix_search(&self, prefix: &str, limit: usize) -> Vec<AddrMatch> {
        let mut seen = HashSet::new();
        self.prefix_search_inner(prefix, limit, &mut seen)
    }

    pub fn prefix_search_any<'a, I>(&self, prefixes: I, limit: usize) -> Vec<AddrMatch>
    where
        I: IntoIterator<Item = &'a str>,
    {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for prefix in prefixes {
            if out.len() >= limit {
                break;
            }
            out.extend(self.prefix_search_inner(prefix, limit - out.len(), &mut seen));
        }
        out
    }

    fn prefix_search_inner(
        &self,
        prefix: &str,
        limit: usize,
        seen: &mut HashSet<usize>,
    ) -> Vec<AddrMatch> {
        if prefix.is_empty() || limit == 0 {
            return Vec::new();
        }

        let mut stream = self.map.range().ge(prefix).into_stream();
        let mut out = Vec::new();
        while let Some((encoded_key, value)) = stream.next() {
            if !encoded_key.starts_with(prefix.as_bytes()) {
                break;
            }
            if out.len() >= limit {
                break;
            }

            let row_id = value as usize;
            if !seen.insert(row_id) {
                continue;
            }
            let (Some(label), Some((lat, lon))) =
                (self.rows.label(row_id), self.rows.lat_lon(row_id))
            else {
                continue;
            };
            out.push(AddrMatch {
                key: decode_lookup_key(encoded_key),
                row_id,
                label: label.to_string(),
                lat,
                lon,
            });
        }
        out
    }
}

#[cfg(test)]
mod row_id_width_tests {
    use super::{encode_fst_key, row_id_width};

    #[test]
    fn width_is_the_digits_needed_for_the_largest_row_id() {
        // Boundaries matter: a corpus of exactly 10 rows has a max id of 9, so
        // one digit still suffices. Off by one here silently widens every key
        // in the artifact.
        assert_eq!(row_id_width(0), 1);
        assert_eq!(row_id_width(1), 1);
        assert_eq!(row_id_width(10), 1, "ids 0..=9");
        assert_eq!(row_id_width(11), 2, "id 10 needs two");
        assert_eq!(row_id_width(100), 2);
        assert_eq!(row_id_width(101), 3);
        assert_eq!(row_id_width(87_531), 5, "the vilnius corpus");
        assert_eq!(row_id_width(1_000_000), 6);
    }

    #[test]
    fn encoded_keys_are_uniform_width_within_one_corpus() {
        // fst::Map is byte-ordered, and entries sharing a lookup key are
        // ordered by this suffix. Ragged widths would sort "10" before "9".
        let width = row_id_width(87_531);
        let a = encode_fst_key("gedimino", 9, width);
        let b = encode_fst_key("gedimino", 10, width);
        assert_eq!(a.len(), b.len());
        assert!(a < b, "{a:?} must sort before {b:?}");
    }

    #[test]
    fn a_row_id_wider_than_the_corpus_still_encodes_losslessly() {
        // `{n:0width$}` pads, it never truncates — so an out-of-range id would
        // widen rather than collide. Nothing should produce one, but a silent
        // collision would drop a row, so pin that it cannot happen.
        assert_eq!(encode_fst_key("k", 1_234_567, 3), "k\u{0}1234567");
    }
}
