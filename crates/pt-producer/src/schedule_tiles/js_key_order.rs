//! Replicates ECMAScript `OrdinaryOwnPropertyKeys` enumeration order for
//! plain-object JSON encoding: any own string key that is a canonical array
//! index (ASCII digits only, no leading zero unless exactly "0", value in
//! [0, 4294967294] — 4294967295 == 2^32-1 is explicitly NOT a valid index)
//! enumerates first in ascending numeric order; all other keys keep
//! insertion order after that. Node's schedule-tile encoders build the
//! `stops` / `trips` / stop-cell maps as plain JS objects (or
//! `Object.create(null)` / `Object.fromEntries`, which are equally subject
//! to this rule — the prototype is irrelevant to key enumeration order),
//! so any `IndexMap` feeding one of those wire outputs must be reordered
//! through this before serialization to stay byte-identical to Node once a
//! GTFS feed uses numeric-looking stop_id/trip_id values.
//!
//! Verified empirically against V8 (node):
//! ```text
//! $ node -e 'const o={}; o["42"]="a"; o["7"]="b"; o["stopA"]="c"; o["3"]="d"; console.log(JSON.stringify(o))'
//! {"3":"d","7":"b","42":"a","stopA":"c"}
//! $ node -e 'const o=Object.create(null); o["9"]=1; o["a"]=2; o["2"]=3; console.log(JSON.stringify(o))'
//! {"2":3,"9":1,"a":2}
//! ```

use indexmap::IndexMap;

/// Returns `Some(v)` if `key` is a canonical JS array index (own-property
/// keys of this shape enumerate before all other string keys, ascending by
/// `v`), else `None` (key stays an ordinary string key, keeping its
/// insertion-relative position among other ordinary keys).
fn js_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.as_bytes()[0] == b'0' {
        return None; // leading zero: not a canonical index ("01" stays a string key)
    }
    let v: u64 = key.parse().ok()?;
    if v > 4_294_967_294 {
        return None; // 2^32-1 (4294967295) is explicitly excluded
    }
    Some(v as u32)
}

/// Return a fresh `IndexMap` with `map`'s entries reordered to JS own-
/// property-key enumeration order: canonical array-index keys first
/// (ascending numeric), then all other keys in their original relative
/// (insertion) order. Does not mutate `map`, and does not clone `V` —
/// values are borrowed, not cloned. For `WireScheduleTile.stops`, `V` holds
/// a `Vec<u32>` pair per stop; cloning every value just to compute a key
/// order would double the tile's peak allocation for no reason (this map
/// is rebuilt once per tile, and tiles can hold thousands of stops). Only
/// the (short, GTFS-ID-sized) keys are cloned, since `IndexMap` needs owned
/// keys — the values ride along as references.
pub fn reordered_like_js_object_keys<V>(map: &IndexMap<String, V>) -> IndexMap<String, &V> {
    let mut indexed: Vec<(u32, &String, &V)> = Vec::new();
    let mut ordinary: Vec<(&String, &V)> = Vec::new();
    for (k, v) in map {
        match js_array_index(k) {
            Some(n) => indexed.push((n, k, v)),
            None => ordinary.push((k, v)),
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);

    let mut out = IndexMap::with_capacity(map.len());
    for (_, k, v) in indexed {
        out.insert(k.clone(), v);
    }
    for (k, v) in ordinary {
        out.insert(k.clone(), v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_array_index_keys() {
        for k in ["0", "1", "7", "10", "42", "4294967294"] {
            assert!(
                js_array_index(k).is_some(),
                "{k} should be a valid JS array index"
            );
        }
        assert_eq!(js_array_index("0"), Some(0));
        assert_eq!(js_array_index("4294967294"), Some(4_294_967_294));
    }

    #[test]
    fn leading_zero_is_not_an_index() {
        assert_eq!(js_array_index("01"), None);
        assert_eq!(js_array_index("00"), None);
        // "0" itself IS valid (exactly "0" is the one allowed single-zero form)
        assert_eq!(js_array_index("0"), Some(0));
    }

    #[test]
    fn max_u32_minus_one_is_excluded() {
        // 4294967295 == 2^32 - 1 is explicitly NOT a valid array index.
        assert_eq!(js_array_index("4294967295"), None);
    }

    #[test]
    fn non_digit_strings_are_not_indices() {
        assert_eq!(js_array_index("-1"), None);
        assert_eq!(js_array_index("stopA"), None);
        assert_eq!(js_array_index(""), None);
        assert_eq!(js_array_index("1.0"), None);
        assert_eq!(js_array_index("+1"), None);
    }

    #[test]
    fn reorders_mixed_keys_matching_v8_repro() {
        // Mirrors: o={}; o["42"]="a"; o["7"]="b"; o["stopA"]="c"; o["3"]="d";
        // JSON.stringify(o) === {"3":"d","7":"b","42":"a","stopA":"c"}
        let mut map: IndexMap<String, String> = IndexMap::new();
        map.insert("42".to_string(), "a".to_string());
        map.insert("7".to_string(), "b".to_string());
        map.insert("stopA".to_string(), "c".to_string());
        map.insert("3".to_string(), "d".to_string());
        let reordered = reordered_like_js_object_keys(&map);
        let keys: Vec<&str> = reordered.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["3", "7", "42", "stopA"]);
    }

    #[test]
    fn numeric_key_inserted_after_string_key_still_sorts_first() {
        // Insert "stopA" then "42" then "7" — proves reordering is not a
        // no-op stable sort: a numeric key inserted LAST still moves ahead
        // of earlier non-numeric keys.
        let mut map: IndexMap<String, i32> = IndexMap::new();
        map.insert("stopA".to_string(), 1);
        map.insert("42".to_string(), 2);
        map.insert("7".to_string(), 3);
        let reordered = reordered_like_js_object_keys(&map);
        let keys: Vec<&str> = reordered.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["7", "42", "stopA"]);
    }

    #[test]
    fn leading_zero_key_keeps_its_ordinary_insertion_position() {
        let mut map: IndexMap<String, i32> = IndexMap::new();
        map.insert("stopA".to_string(), 1);
        map.insert("01".to_string(), 2); // NOT an index — ordinary key
        map.insert("stopB".to_string(), 3);
        let reordered = reordered_like_js_object_keys(&map);
        let keys: Vec<&str> = reordered.keys().map(String::as_str).collect();
        // No canonical index keys present, so ordinary keys keep original order.
        assert_eq!(keys, vec!["stopA", "01", "stopB"]);
    }

    #[test]
    fn max_valid_index_and_excluded_max_u32_together() {
        let mut map: IndexMap<String, i32> = IndexMap::new();
        map.insert("4294967295".to_string(), 1); // excluded -> ordinary key
        map.insert("stopA".to_string(), 2);
        map.insert("4294967294".to_string(), 3); // max valid index
        let reordered = reordered_like_js_object_keys(&map);
        let keys: Vec<&str> = reordered.keys().map(String::as_str).collect();
        // Only "4294967294" is a valid index -> sorts first; the rest keep
        // their relative insertion order.
        assert_eq!(keys, vec!["4294967294", "4294967295", "stopA"]);
    }

    #[test]
    fn empty_map_reorders_to_empty() {
        let map: IndexMap<String, i32> = IndexMap::new();
        let reordered = reordered_like_js_object_keys(&map);
        assert!(reordered.is_empty());
    }
}
