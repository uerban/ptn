//! Port of packages/backend/src/gtfs/colorblindPalettes.ts — CVD
//! (colorblindness) -aware palette optimization: nudges route colors in
//! OKLCH so they stay distinguishable under deuteranopia/protanopia/
//! tritanopia simulation, plus an aggressive-remap high-contrast variant and
//! a WCAG-contrast-driven dark-theme adjustment.
//!
//! **Important divergence from what a naive reading of colorClustering.ts's
//! sibling `cluster.rs`/`color_math.rs` might suggest:** this file's
//! ciede2000 comparisons operate on colors that arrive as RGB-mode culori
//! objects (`parse(hexString)`), NOT the D50 Lab-mode objects
//! colorClustering.ts uses. culori's `converter()` resolves a conversion via
//! a DIRECT mode-pair lookup before falling back to a via-RGB hop, and
//! `lab65` registers a direct `rgb → lab65` edge — so an RGB-mode input
//! takes a different code path (and, empirically, a numerically different
//! result at the ~1e-5..1e-7 level, not just float noise) than a D50
//! Lab-mode input would. Use `color_math::rgb_to_lab65` +
//! `color_math::ciede2000_lab65` here, NOT `color_math::hex_to_lab` +
//! `color_math::ciede2000` (those are for colorClustering.ts's D50 Lab-mode
//! objects only). See `color_math.rs`'s `rgb_to_xyz65` doc comment for the
//! full explanation and the empirical bit-exactness check against culori's
//! actual output.

use indexmap::IndexMap;

use super::color_math::{
    ciede2000_lab65, format_hex, oklch_to_rgb, parse_hex, rgb_to_lab65, rgb_to_oklch, simulate_cvd,
    CvdType, Lab,
};

/// Minimum ΔE (CIEDE2000, in simulated CVD space) between any pair of
/// palette colors that `minimalShiftPalette` accepts without further
/// nudging (colorblindPalettes.ts:42 `const MIN_DISTANCE = 15`).
const MIN_DISTANCE: f64 = 15.0;

/// Minimum WCAG contrast ratio a dark-theme palette color must reach
/// against the dark surface color (colorblindPalettes.ts:174
/// `const MIN_DARK_CONTRAST = 3.0`).
const MIN_DARK_CONTRAST: f64 = 3.0;

/// `PaletteMap` = `Record<string, string>` in TS — a plain id→hex map. JS object key order for
/// non-numeric keys is insertion order, and `computePalettes`'s output feeds `JSON.stringify` at
/// the top level of color-config.json, so key order must match the `subModes` array order
/// `cluster_route_colors` (cluster.rs) already produces deterministically — hence `IndexMap`, not
/// `HashMap`/`BTreeMap`, matching cluster.rs's own `IndexMap` usage for the same reason.
type PaletteMap = IndexMap<String, String>;

/// colorblindPalettes.ts's `simulateCvd`: parse a hex string, run it through
/// culori's CVD simulation filter, and re-format to hex. Falls back to the
/// original (possibly `#`-prefixed) string unchanged when parsing fails,
/// matching `simulateCvd`'s `if (!parsed) return h;` guard.
fn simulate_cvd_hex(hex: &str, kind: CvdType) -> String {
    match parse_hex(hex) {
        Some(rgb) => format_hex(simulate_cvd(rgb, kind)),
        None => hex.to_string(),
    }
}

/// colorblindPalettes.ts's `minPairwiseDistance`: the minimum ciede2000
/// distance across all pairs in a list of hex colors. Unparseable entries
/// are skipped (matching TS's `if (c1 && c2)` guard).
fn min_pairwise_distance(colors: &[String]) -> f64 {
    let mut min = f64::INFINITY;
    for i in 0..colors.len() {
        for j in (i + 1)..colors.len() {
            if let (Some(a), Some(b)) = (parse_hex(&colors[i]), parse_hex(&colors[j])) {
                let d = ciede2000_lab65(rgb_to_lab65(a), rgb_to_lab65(b));
                if d < min {
                    min = d;
                }
            }
        }
    }
    min
}

/// colorblindPalettes.ts's `minimalShiftPalette`: nudge colors in OKLCH
/// (hue +25°, chroma +0.02 capped at 0.3) to improve the worst-pair CVD-
/// simulated ciede2000 distance, up to 15 iterations
/// (colorblindPalettes.ts:79 `for (let iter = 0; iter < 15; iter++)`).
///
/// On the inner worst-pair search: TS tracks `worstI`/`worstJ` together but
/// only ever reads `worstJ` afterward (`const nudgeIdx = worstJ;`,
/// colorblindPalettes.ts:104) — `worstI` is assigned on every improved
/// candidate but never read again, confirmed by re-reading
/// colorblindPalettes.ts:79-119 in full. This port only tracks `worst_j`,
/// which is behaviorally identical to tracking both and discarding `worstI`.
// `needless_range_loop` would otherwise push the inner `for j in (i+1)..`
// search toward `.iter().enumerate().skip()/.take()` combinators; kept as a
// plain indexed double loop instead so this function's shape mirrors
// colorblindPalettes.ts's own nested `for (i...) for (j...)` search
// (colorblindPalettes.ts:86-99) line-for-line for future parity audits —
// the same rationale color_math.rs uses for its own `#[allow]`s.
#[allow(clippy::needless_range_loop)]
fn minimal_shift_palette(base_colors: &PaletteMap, cvd_types: &[CvdType]) -> PaletteMap {
    let ids: Vec<String> = base_colors.keys().cloned().collect();
    let mut adjusted = base_colors.clone();

    // Pre-compute simulated Lab65 colors per CVD type; each iteration only
    // re-simulates the nudged color (mirrors TS's simCache Map).
    let mut sim_cache: Vec<(CvdType, Vec<Option<Lab>>)> = cvd_types
        .iter()
        .map(|&cvd| {
            let parsed = ids
                .iter()
                .map(|id| {
                    let hex = simulate_cvd_hex(&adjusted[id], cvd);
                    parse_hex(&hex).map(rgb_to_lab65)
                })
                .collect();
            (cvd, parsed)
        })
        .collect();

    for _iter in 0..15 {
        let mut worst_dist = f64::INFINITY;
        let mut worst_j = 1usize;

        for (_, parsed) in &sim_cache {
            for i in 0..ids.len() {
                let Some(c1) = parsed[i] else { continue };
                for j in (i + 1)..ids.len() {
                    let Some(c2) = parsed[j] else { continue };
                    let d = ciede2000_lab65(c1, c2);
                    if d < worst_dist {
                        worst_dist = d;
                        worst_j = j;
                    }
                }
            }
        }

        if worst_dist >= MIN_DISTANCE {
            break;
        }

        let nudge_idx = worst_j;
        let Some(rgb) = parse_hex(&adjusted[&ids[nudge_idx]]) else {
            break;
        };
        let mut oklch = rgb_to_oklch(rgb);
        oklch.h = (oklch.h + 25.0) % 360.0;
        oklch.c = (oklch.c + 0.02).min(0.3);
        let new_hex = format_hex(oklch_to_rgb(oklch));
        adjusted.insert(ids[nudge_idx].clone(), new_hex.clone());

        // Only re-simulate the nudged color in the cache.
        for (cvd, parsed) in sim_cache.iter_mut() {
            let hex = simulate_cvd_hex(&new_hex, *cvd);
            parsed[nudge_idx] = parse_hex(&hex).map(rgb_to_lab65);
        }
    }

    adjusted
}

/// colorblindPalettes.ts's `aggressiveRemapPalette`: spread colors evenly
/// across the full hue circle, ignoring original hue (mode identity is
/// intentionally discarded for maximum distinction — see the TS doc
/// comment on this function). Lightness is preserved from the original
/// color (clamped to [0.4, 0.8]); chroma is fixed at 0.2.
fn aggressive_remap_palette(base_colors: &PaletteMap) -> PaletteMap {
    let ids: Vec<String> = base_colors.keys().cloned().collect();
    let n = ids.len() as f64;
    let mut result = PaletteMap::new();
    for (i, id) in ids.iter().enumerate() {
        let hue = (i as f64 * 360.0) / n;
        let l = parse_hex(&base_colors[id])
            .map(rgb_to_oklch)
            .map(|o| o.l)
            .unwrap_or(0.6);
        let l = l.clamp(0.4, 0.8);
        let hex = format_hex(oklch_to_rgb(super::color_math::Oklch { l, c: 0.2, h: hue }));
        result.insert(id.clone(), hex);
    }
    result
}

/// colorblindPalettes.ts's `relativeLuminance`: WCAG 2.1 relative
/// luminance from a hex color. Malformed input yields `0.0` (this codebase
/// never actually calls it with malformed input — `adjustForDarkTheme` only
/// feeds it culori-produced hex strings — so this is a defensive fallback,
/// not an observed code path).
fn relative_luminance(hex: &str) -> f64 {
    let Some(rgb) = parse_hex(hex) else {
        return 0.0;
    };
    let to_linear = |c: f64| {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * to_linear(rgb.r) + 0.7152 * to_linear(rgb.g) + 0.0722 * to_linear(rgb.b)
}

/// colorblindPalettes.ts's `wcagContrastRatio`.
fn wcag_contrast_ratio(hex1: &str, hex2: &str) -> f64 {
    let (l1, l2) = (relative_luminance(hex1), relative_luminance(hex2));
    let (lighter, darker) = (l1.max(l2), l1.min(l2));
    (lighter + 0.05) / (darker + 0.05)
}

/// colorblindPalettes.ts's `adjustForDarkTheme`: increase OKLCH lightness
/// (in 0.04 steps, up to 20 attempts — colorblindPalettes.ts:192 `while
/// (attempts < 20)`) until the WCAG contrast ratio against the dark surface
/// color `#1f2937` reaches `MIN_DARK_CONTRAST`. Falls back to the original
/// (unmodified) hex if 20 attempts are exhausted without reaching target
/// contrast (colorblindPalettes.ts:202 `if (!result[id]) result[id] = hex;`).
fn adjust_for_dark_theme(palette: &PaletteMap) -> PaletteMap {
    const DARK_SURFACE: &str = "#1f2937";
    let mut result = PaletteMap::new();
    for (id, hex) in palette {
        let Some(rgb) = parse_hex(hex) else {
            result.insert(id.clone(), hex.clone());
            continue;
        };
        let mut oklch = rgb_to_oklch(rgb);
        let mut found = None;
        for _attempt in 0..20 {
            let candidate = format_hex(oklch_to_rgb(oklch));
            if wcag_contrast_ratio(&candidate, DARK_SURFACE) >= MIN_DARK_CONTRAST {
                found = Some(candidate);
                break;
            }
            oklch.l = (oklch.l + 0.04).min(0.95);
        }
        result.insert(id.clone(), found.unwrap_or_else(|| hex.clone()));
    }
    result
}

/// One CVD-optimized palette set (either the light-theme or dark-theme
/// variant): `universal` targets all three CVD types at once, the other
/// three each target a single CVD type, and `high_contrast` is the
/// aggressive hue-spread remap. Mirrors TS's `ThemePalettes` shape
/// (`@pt/shared`).
pub struct ThemePalettes {
    pub universal: PaletteMap,
    pub deuteranopia: PaletteMap,
    pub protanopia: PaletteMap,
    pub tritanopia: PaletteMap,
    pub high_contrast: PaletteMap,
}

/// Output of `compute_palettes`: light/dark theme palette sets, plus
/// whether the universal (all-3-CVD-types) palette failed to reach
/// `MIN_DISTANCE` for every simulated CVD type.
pub struct PalettesResult {
    pub light: ThemePalettes,
    pub dark: ThemePalettes,
    pub universal_limited: bool,
}

/// Port of colorblindPalettes.ts's `computePalettes`.
pub fn compute_palettes(base_colors: &PaletteMap) -> PalettesResult {
    let cvd_types = [
        CvdType::Deuteranopia,
        CvdType::Protanopia,
        CvdType::Tritanopia,
    ];

    let deuteranopia = minimal_shift_palette(base_colors, &[CvdType::Deuteranopia]);
    let protanopia = minimal_shift_palette(base_colors, &[CvdType::Protanopia]);
    let tritanopia = minimal_shift_palette(base_colors, &[CvdType::Tritanopia]);
    let universal = minimal_shift_palette(base_colors, &cvd_types);

    let mut universal_limited = false;
    for &cvd in &cvd_types {
        let simulated: Vec<String> = universal
            .values()
            .map(|c| simulate_cvd_hex(c, cvd))
            .collect();
        if min_pairwise_distance(&simulated) < MIN_DISTANCE {
            universal_limited = true;
            break;
        }
    }

    let high_contrast = aggressive_remap_palette(base_colors);

    let light = ThemePalettes {
        universal: universal.clone(),
        deuteranopia: deuteranopia.clone(),
        protanopia: protanopia.clone(),
        tritanopia: tritanopia.clone(),
        high_contrast: high_contrast.clone(),
    };
    let dark = ThemePalettes {
        universal: adjust_for_dark_theme(&universal),
        deuteranopia: adjust_for_dark_theme(&deuteranopia),
        protanopia: adjust_for_dark_theme(&protanopia),
        tritanopia: adjust_for_dark_theme(&tritanopia),
        high_contrast: adjust_for_dark_theme(&high_contrast),
    };

    PalettesResult {
        light,
        dark,
        universal_limited,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette(pairs: &[(&str, &str)]) -> PaletteMap {
        pairs
            .iter()
            .map(|(id, hex)| (id.to_string(), hex.to_string()))
            .collect()
    }

    // --- computePalettes: well-separated colors need no universal shift ---

    #[test]
    fn well_separated_colors_leave_universal_limited_false() {
        // Blue and orange are far apart under all three CVD simulations —
        // deuteranopia/protanopia (red-green) and tritanopia (blue-yellow)
        // alike — so the universal palette should already clear
        // MIN_DISTANCE without needing `universalLimited`.
        let base = palette(&[("BUS", "#1d4ed8"), ("RAIL", "#f59e0b")]);
        let result = compute_palettes(&base);
        assert!(
            !result.universal_limited,
            "expected well-separated colors to not be universal-limited"
        );
    }

    // --- computePalettes: CVD-confusable colors trigger universalLimited ---

    #[test]
    fn cvd_confusable_mode_palette_sets_universal_limited_and_shifts_the_palette() {
        // These are cluster.rs's own `default_mode_color` values (BUS/TRAM/
        // METRO/RAIL/FERRY) — a realistic 5-color palette. Ground truth
        // established by running this exact algorithm against the real
        // culori@4.0.2 library (this repo's pinned version): after
        // minimalShiftPalette's shifting, at least one CVD type still fails
        // to clear MIN_DISTANCE for the universal palette (confirmed
        // separately that a plain red/green pair does NOT trigger this —
        // CIEDE2000-on-simulated-colors doesn't treat pure red/green as
        // confusable the way naive human intuition about deuteranopia
        // might suggest, so a real multi-color, closely-spaced-hue palette
        // is needed to actually exercise this branch).
        let base = palette(&[
            ("BUS", "#1d4ed8"),
            ("TRAM", "#16a34a"),
            ("METRO", "#dc2626"),
            ("RAIL", "#ea580c"),
            ("FERRY", "#0891b2"),
        ]);
        let result = compute_palettes(&base);
        assert!(
            result.universal_limited,
            "expected this 5-color mode palette to be universal-limited"
        );

        // The universal palette must have been measurably nudged away from
        // the base colors (minimalShiftPalette ran at least one iteration).
        let shifted = result
            .light
            .universal
            .iter()
            .any(|(id, hex)| hex != &base[id]);
        assert!(
            shifted,
            "expected the universal palette to shift at least one route's color"
        );
    }

    #[test]
    fn cvd_confusable_mode_palette_matches_real_culori_golden_output() {
        // Byte-exact golden values obtained by running this exact algorithm (transcribed faithfully
        // from colorblindPalettes.ts) against the real, pinned culori@4.0.2 library for this same
        // 5-color fixture — covering every variant `computePalettes` produces (light+dark x
        // universal/deuteranopia/protanopia/tritanopia/highContrast). This is the strongest parity
        // check available short of the differential CI gate itself.
        let base = palette(&[
            ("BUS", "#1d4ed8"),
            ("TRAM", "#16a34a"),
            ("METRO", "#dc2626"),
            ("RAIL", "#ea580c"),
            ("FERRY", "#0891b2"),
        ]);
        let result = compute_palettes(&base);
        assert!(result.universal_limited);

        let check = |got: &PaletteMap, expected: &[(&str, &str)], label: &str| {
            for (id, want) in expected {
                assert_eq!(
                    got[*id], *want,
                    "{label}[{id}]: got {} want {want}",
                    got[*id]
                );
            }
        };

        check(
            &result.light.universal,
            &[
                ("BUS", "#1d4ed8"),
                ("TRAM", "#16a34a"),
                ("METRO", "#dc2626"),
                ("RAIL", "#00b9b9"),
                ("FERRY", "#f31700"),
            ],
            "light.universal",
        );
        check(
            &result.light.deuteranopia,
            &[
                ("BUS", "#1d4ed8"),
                ("TRAM", "#16a34a"),
                ("METRO", "#8b8800"),
                ("RAIL", "#00b78d"),
                ("FERRY", "#3488cc"),
            ],
            "light.deuteranopia",
        );
        check(
            &result.light.protanopia,
            &[
                ("BUS", "#1d4ed8"),
                ("TRAM", "#16a34a"),
                ("METRO", "#dc2626"),
                ("RAIL", "#ea580c"),
                ("FERRY", "#0891b2"),
            ],
            "light.protanopia",
        );
        check(
            &result.light.tritanopia,
            &[
                ("BUS", "#1d4ed8"),
                ("TRAM", "#16a34a"),
                ("METRO", "#dc2626"),
                ("RAIL", "#a79400"),
                ("FERRY", "#8f68db"),
            ],
            "light.tritanopia",
        );
        check(
            &result.light.high_contrast,
            &[
                ("BUS", "#b0005b"),
                ("TRAM", "#cf6b00"),
                ("METRO", "#009508"),
                ("RAIL", "#00a7da"),
                ("FERRY", "#8166f1"),
            ],
            "light.high_contrast",
        );

        check(
            &result.dark.universal,
            &[
                ("BUS", "#3369f4"),
                ("TRAM", "#16a34a"),
                ("METRO", "#dc2626"),
                ("RAIL", "#00b9b9"),
                ("FERRY", "#f31700"),
            ],
            "dark.universal",
        );
        check(
            &result.dark.deuteranopia,
            &[
                ("BUS", "#3369f4"),
                ("TRAM", "#16a34a"),
                ("METRO", "#8b8800"),
                ("RAIL", "#00b78d"),
                ("FERRY", "#3488cc"),
            ],
            "dark.deuteranopia",
        );
        check(
            &result.dark.protanopia,
            &[
                ("BUS", "#3369f4"),
                ("TRAM", "#16a34a"),
                ("METRO", "#dc2626"),
                ("RAIL", "#ea580c"),
                ("FERRY", "#0891b2"),
            ],
            "dark.protanopia",
        );
        check(
            &result.dark.tritanopia,
            &[
                ("BUS", "#3369f4"),
                ("TRAM", "#16a34a"),
                ("METRO", "#dc2626"),
                ("RAIL", "#a79400"),
                ("FERRY", "#8f68db"),
            ],
            "dark.tritanopia",
        );
        check(
            &result.dark.high_contrast,
            &[
                ("BUS", "#db3e7d"),
                ("TRAM", "#cf6b00"),
                ("METRO", "#009508"),
                ("RAIL", "#00a7da"),
                ("FERRY", "#8166f1"),
            ],
            "dark.high_contrast",
        );
    }

    // --- computePalettes: every variant preserves base_colors key order ---

    #[test]
    fn compute_palettes_preserves_base_color_key_order_across_all_variants_and_themes() {
        // Mirrors colorblindPalettes.test.ts's computePalettes test:
        // `expect(Object.keys(palettes[theme][key])).toEqual(Object.keys(baseColors))`
        // for all 5 palette keys x 2 themes. Insertion order here (FERRY,
        // BUS, RAIL, METRO, TRAM) deliberately matches neither an
        // alphabetical sort (BUS, FERRY, METRO, RAIL, TRAM) nor a
        // length-based sort (BUS=3, RAIL=4, TRAM=4, FERRY=5, METRO=5), so a
        // latent key-reordering bug in any variant couldn't accidentally
        // pass by coincidence.
        let base = palette(&[
            ("FERRY", "#0891b2"),
            ("BUS", "#1d4ed8"),
            ("RAIL", "#ea580c"),
            ("METRO", "#dc2626"),
            ("TRAM", "#16a34a"),
        ]);
        let expected_order: Vec<&String> = base.keys().collect();
        let result = compute_palettes(&base);

        for (theme_label, theme) in [("light", &result.light), ("dark", &result.dark)] {
            for (variant_label, variant) in [
                ("universal", &theme.universal),
                ("deuteranopia", &theme.deuteranopia),
                ("protanopia", &theme.protanopia),
                ("tritanopia", &theme.tritanopia),
                ("high_contrast", &theme.high_contrast),
            ] {
                let got_order: Vec<&String> = variant.keys().collect();
                assert_eq!(
                    got_order, expected_order,
                    "{theme_label}.{variant_label} key order mismatch"
                );
            }
        }
    }

    // --- adjustForDarkTheme: every output entry clears MIN_DARK_CONTRAST ---

    #[test]
    fn dark_theme_palettes_always_clear_min_contrast_against_dark_surface() {
        let base = palette(&[
            ("BUS", "#1d4ed8"),
            ("TRAM", "#16a34a"),
            ("METRO", "#dc2626"),
            ("RAIL", "#111111"), // near-black: needs real lightening to pass
        ]);
        let result = compute_palettes(&base);

        for theme_palette in [
            &result.dark.universal,
            &result.dark.deuteranopia,
            &result.dark.protanopia,
            &result.dark.tritanopia,
            &result.dark.high_contrast,
        ] {
            for (id, hex) in theme_palette {
                let ratio = wcag_contrast_ratio(hex, "#1f2937");
                assert!(
                    ratio >= MIN_DARK_CONTRAST,
                    "dark palette entry {id}={hex} has contrast {ratio} < {MIN_DARK_CONTRAST}"
                );
            }
        }
    }

    // --- minimalShiftPalette / minPairwiseDistance behavior in isolation ---

    #[test]
    fn minimal_shift_palette_is_a_no_op_when_already_well_separated() {
        let base = palette(&[("A", "#000000"), ("B", "#ffffff")]);
        let shifted = minimal_shift_palette(&base, &[CvdType::Deuteranopia]);
        assert_eq!(shifted["A"], base["A"]);
        assert_eq!(shifted["B"], base["B"]);
    }

    #[test]
    fn min_pairwise_distance_of_identical_colors_is_zero() {
        let colors = vec!["#336699".to_string(), "#336699".to_string()];
        assert_eq!(min_pairwise_distance(&colors), 0.0);
    }

    #[test]
    fn min_pairwise_distance_skips_unparseable_entries() {
        let colors = vec!["#ff0000".to_string(), "not-a-color".to_string()];
        // Only one parseable entry (or a malformed pair) means no valid
        // pairwise comparison exists, so the min stays at its Infinity seed.
        assert_eq!(min_pairwise_distance(&colors), f64::INFINITY);
    }

    // --- aggressiveRemapPalette: ignores original hue, spreads evenly -----

    #[test]
    fn aggressive_remap_spreads_hues_and_preserves_key_order() {
        let base = palette(&[("A", "#ff0000"), ("B", "#ff0000"), ("C", "#ff0000")]);
        let remapped = aggressive_remap_palette(&base);
        let ids: Vec<&String> = remapped.keys().collect();
        assert_eq!(ids, vec!["A", "B", "C"]);

        // Same input hue for every entry, but the remap spreads output hues
        // evenly across the circle (0°, 120°, 240° for n=3), so all 3
        // output hex values must be pairwise distinct even though every
        // input color was identical.
        let hexes: Vec<&String> = remapped.values().collect();
        assert_ne!(hexes[0], hexes[1]);
        assert_ne!(hexes[1], hexes[2]);
        assert_ne!(hexes[0], hexes[2]);
    }
}
