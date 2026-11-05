use pt_geocode::{
    address_search_query_variants, normalize_address_search_text, AddrIndex, AddrKey, AddrRow,
};

fn row(label: &str, lat: f64, lon: f64) -> AddrRow {
    AddrRow {
        label: label.into(),
        lat,
        lon,
    }
}

fn key(key: &str, row_id: usize) -> AddrKey {
    AddrKey {
        key: key.into(),
        row_id,
    }
}

#[test]
fn build_and_query_single_entry() {
    let rows = vec![row("Gedimino pr. 9", 54.6872, 25.2797)];
    let keys = vec![key("gedimino prospektas 9", 0), key("gedimino pr 9", 0)];

    let index = AddrIndex::build(&rows, &keys).expect("build should succeed");
    let matches = index.prefix_search("gedimino", 10);

    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].key, "gedimino pr 9");
    assert_eq!(matches[0].label, "Gedimino pr. 9");
    assert!((matches[0].lat - 54.6872).abs() < 1e-6);
    assert!((matches[0].lon - 25.2797).abs() < 1e-6);
}

#[test]
fn prefix_search_excludes_non_matching_keys() {
    let rows = vec![
        row("Gedimino pr. 9", 54.6872, 25.2797),
        row("Gedimino pr. 10", 54.6875, 25.2801),
        row("Pilies g. 5", 54.6836, 25.2879),
    ];
    let keys = vec![
        key("gedimino pr 9", 0),
        key("gedimino pr 10", 1),
        key("pilies gatve 5", 2),
    ];

    let index = AddrIndex::build(&rows, &keys).expect("build should succeed");
    let matches = index.prefix_search("gedimino", 10);

    assert_eq!(matches.len(), 2);
    assert!(matches.iter().all(|m| m.key.starts_with("gedimino")));
}

#[test]
fn prefix_search_respects_limit() {
    let rows = vec![
        row("A st 1", 1.0, 1.0),
        row("A st 2", 2.0, 2.0),
        row("A st 3", 3.0, 3.0),
    ];
    let keys = vec![key("a st 1", 0), key("a st 2", 1), key("a st 3", 2)];

    let index = AddrIndex::build(&rows, &keys).expect("build should succeed");
    let matches = index.prefix_search("a st", 2);

    assert_eq!(matches.len(), 2);
}

#[test]
fn prefix_search_no_match_returns_empty() {
    let rows = vec![row("Gedimino pr. 9", 54.6872, 25.2797)];
    let keys = vec![key("gedimino pr 9", 0)];

    let index = AddrIndex::build(&rows, &keys).expect("build should succeed");
    let matches = index.prefix_search("pilies", 10);

    assert!(matches.is_empty());
}

#[test]
fn size_bytes_scales_with_distinct_key_count() {
    let rows = vec![row("A st 1", 1.0, 1.0)];
    let one = vec![key("a st 1", 0)];
    let many: Vec<AddrKey> = (0..1000).map(|i| key(&format!("a st {i}"), 0)).collect();

    let one_index = AddrIndex::build(&rows, &one).unwrap();
    let many_index = AddrIndex::build(&rows, &many).unwrap();

    assert!(one_index.size_bytes() > 0);
    assert!(many_index.size_bytes() > one_index.size_bytes());
}

#[test]
fn duplicate_keys_for_same_row_are_deduped() {
    let rows = vec![row("Gedimino pr. 9", 54.6872, 25.2797)];
    let keys = vec![key("gedimino pr 9", 0), key("gedimino pr 9", 0)];

    let index = AddrIndex::build(&rows, &keys).expect("build should succeed on duplicate keys");
    let matches = index.prefix_search("gedimino", 10);

    assert_eq!(matches.len(), 1);
}

#[test]
fn same_lookup_key_can_point_to_multiple_rows() {
    let rows = vec![
        row("Gedimino pr. 9", 54.6872, 25.2797),
        row("Gedimino pr. 9A", 54.6873, 25.2798),
    ];
    let keys = vec![key("gedimino pr 9", 0), key("gedimino pr 9", 1)];

    let index = AddrIndex::build(&rows, &keys).expect("build should preserve row collisions");
    let matches = index.prefix_search("gedimino pr 9", 10);

    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].label, "Gedimino pr. 9");
    assert_eq!(matches[1].label, "Gedimino pr. 9A");
}

#[test]
fn prefix_search_any_dedupes_rows_across_query_variants() {
    let rows = vec![row("V. Kudirkos aikštė 1", 54.6872, 25.2797)];
    let keys = vec![key("kudirkos aikste 1", 0), key("kudirk aikste 1", 0)];

    let index = AddrIndex::build(&rows, &keys).expect("build should succeed");
    let matches = index.prefix_search_any(["kudirk", "kudirkos"].as_slice().iter().copied(), 10);

    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].label, "V. Kudirkos aikštė 1");
}

#[test]
fn build_rejects_key_with_out_of_range_row_id() {
    let rows = vec![row("Gedimino pr. 9", 54.6872, 25.2797)];
    let result = AddrIndex::build(&rows, &[key("gedimino pr 9", 1)]);

    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(err.to_string().contains("points at row 1"));
}

#[test]
fn normalizer_handles_lithuanian_diacritics() {
    assert_eq!(
        normalize_address_search_text("Šeimyniškių g. 12"),
        "seimyniskiu g 12"
    );
}

#[test]
fn normalizer_transliterates_cyrillic_prefixes() {
    assert_eq!(normalize_address_search_text("Кудирк"), "kudirk");
    let variants = address_search_query_variants("площадь Кудирки");
    assert!(
        variants.iter().any(|v| v == "aikste kudirk"),
        "{variants:?}"
    );
}

#[test]
fn normalizer_transliterates_arabic_street_terms() {
    assert_eq!(
        normalize_address_search_text("شارع الاستقلال"),
        "shara alastqlal"
    );
    let variants = address_search_query_variants("شارع الاستقلال");
    assert!(
        variants.iter().any(|v| v == "gatve alastqlal"),
        "{variants:?}"
    );
}

#[test]
fn query_rotates_leading_address_term_for_slavic_word_order() {
    // Mirrors the TS test in packages/shared/src/addressSearch/normalizer.test.ts.
    // `площадь Кудирки` puts the generic term first; the Lithuanian labels in
    // the corpus put it last. The corpus no longer stores a term-first alias
    // per row, so the rotated QUERY variant is what bridges the two.
    let variants = address_search_query_variants("площадь Кудирки");
    assert!(
        variants.iter().any(|v| v == "aikste kudirk"),
        "synonym+stem form missing: {variants:?}"
    );
    assert!(
        variants.iter().any(|v| v == "kudirk aikste"),
        "rotated form missing: {variants:?}"
    );
}

#[test]
fn query_rotation_leaves_term_last_input_untouched() {
    let variants = address_search_query_variants("Kudirkos aikštė");
    assert!(
        variants.iter().any(|v| v == "kudirkos aikste"),
        "{variants:?}"
    );
    assert!(
        !variants.iter().any(|v| v == "aikste kudirkos"),
        "term-last input must not be rotated: {variants:?}"
    );
}

#[test]
fn rotated_query_reaches_a_term_last_row() {
    // End-to-end through the index: a Slavic term-first query must still find a
    // row whose only stored keys are term-last.
    let rows = vec![AddrRow {
        label: "V. Kudirkos aikštė 1".to_string(),
        lat: 54.6879,
        lon: 25.2757,
    }];
    let keys = vec![
        AddrKey {
            key: "v kudirkos aikste 1".to_string(),
            row_id: 0,
        },
        AddrKey {
            key: "kudirkos aikste 1".to_string(),
            row_id: 0,
        },
        AddrKey {
            key: "kudirk aikste 1".to_string(),
            row_id: 0,
        },
    ];
    let index = AddrIndex::build(&rows, &keys).expect("build");
    let variants = address_search_query_variants("площадь Кудирки");
    let hits = index.prefix_search_any(variants.iter().map(String::as_str), 5);
    assert_eq!(hits.len(), 1, "expected the term-last row: {hits:?}");
    assert_eq!(hits[0].row_id, 0);
}

#[test]
fn query_rotation_places_term_before_the_house_number() {
    // Mirrors the TS test. `проспект Гедимино 23` must reach the stored key
    // `gedimino prospektas 23`; appending the term after the number yields
    // `gedimino 23 prospektas`, which prefix-matches nothing.
    let variants = address_search_query_variants("проспект Гедимино 23");
    assert!(
        variants.iter().any(|v| v == "gedimino prospektas 23"),
        "{variants:?}"
    );
    assert!(
        !variants.iter().any(|v| v == "gedimino 23 prospektas"),
        "{variants:?}"
    );
}
