//! Port of packages/backend/src/gtfs/colorClustering.ts — CIEDE2000-based
//! route-color clustering ("sub-modes" for map rendering).

use std::collections::HashMap;

use indexmap::IndexMap;

use super::color_math::{
    ciede2000, format_hex, hex_to_lab, lab_to_rgb, oklch_to_rgb, parse_hex, rgb_to_oklch, Lab,
    Oklch,
};
use super::inputs::ColorArtifactRoute;

// Thresholds calibrated for transit GTFS feeds:
// - MERGE_THRESHOLD (deltaE<10): visually indistinguishable colors merge into one cluster
// - OUTLIER_THRESHOLD (deltaE>25): a single route is far enough to be its own sub-mode
const MERGE_THRESHOLD: f64 = 10.0;
const OUTLIER_THRESHOLD: f64 = 25.0;

/// Minimum number of colorless routes before we generate a varied palette
/// instead of assigning them all the same default color.
const NO_COLOR_PALETTE_THRESHOLD: usize = 4;

/// OKLCH hue ranges per mode for generating varied route colors. Each mode
/// gets a ~80-degree hue arc so generated colors stay within the mode's
/// visual family.
struct HueRange {
    hue_start: f64,
    hue_end: f64,
    lightness: f64,
    chroma: f64,
}

fn mode_hue_range(mode: &str) -> Option<HueRange> {
    Some(match mode {
        "BUS" => HueRange {
            hue_start: 250.0,
            hue_end: 310.0,
            lightness: 0.55,
            chroma: 0.16,
        },
        "TRAM" => HueRange {
            hue_start: 110.0,
            hue_end: 150.0,
            lightness: 0.55,
            chroma: 0.14,
        },
        "TROLLEYBUS" => HueRange {
            hue_start: 170.0,
            hue_end: 200.0,
            lightness: 0.50,
            chroma: 0.13,
        },
        "METRO" => HueRange {
            hue_start: 10.0,
            hue_end: 60.0,
            lightness: 0.55,
            chroma: 0.18,
        },
        "RAIL" => HueRange {
            hue_start: 60.0,
            hue_end: 105.0,
            lightness: 0.55,
            chroma: 0.15,
        },
        "FERRY" => HueRange {
            hue_start: 205.0,
            hue_end: 240.0,
            lightness: 0.55,
            chroma: 0.13,
        },
        "CABLE_TRAM" => HueRange {
            hue_start: 290.0,
            hue_end: 320.0,
            lightness: 0.55,
            chroma: 0.15,
        },
        "AERIAL" => HueRange {
            hue_start: 320.0,
            hue_end: 350.0,
            lightness: 0.55,
            chroma: 0.15,
        },
        "OTHER" => HueRange {
            hue_start: 250.0,
            hue_end: 290.0,
            lightness: 0.45,
            chroma: 0.04,
        },
        "FUNICULAR" => HueRange {
            hue_start: 290.0,
            hue_end: 350.0,
            lightness: 0.55,
            chroma: 0.15,
        },
        _ => return None,
    })
}

fn mode_label(mode: &str) -> &str {
    match mode {
        "BUS" => "Bus",
        "TRAM" => "Tram",
        "TROLLEYBUS" => "Trolleybus",
        "METRO" => "Metro",
        "RAIL" => "Rail",
        "FERRY" => "Ferry",
        "CABLE_TRAM" => "Cable tram",
        "AERIAL" => "Aerial",
        "OTHER" => "Other",
        "FUNICULAR" => "Funicular",
        "WALK" => "Walk",
        "BIKE" => "Bike",
        "BIKE_SHARE" => "Bike share",
        "SCOOTER" => "Scooter",
        "CAR" => "Car",
        other => other,
    }
}

fn default_mode_color(mode: &str) -> &'static str {
    match mode {
        "BUS" => "#1d4ed8",
        "TRAM" => "#16a34a",
        "TROLLEYBUS" => "#0d9488",
        "METRO" => "#dc2626",
        "RAIL" => "#ea580c",
        "FERRY" => "#0891b2",
        "CABLE_TRAM" => "#9333ea",
        "AERIAL" => "#c026d3",
        "OTHER" => "#64748b",
        "FUNICULAR" => "#7c3aed",
        _ => "#6b7280",
    }
}

/// colorClustering.ts hashStringToUnit — FNV-1a-inspired, deterministic,
/// exact 32-bit wraparound arithmetic. Rust's `u32` wrapping_mul (via
/// `wrapping_mul`) reproduces JS's `Math.imul` (32-bit signed multiply,
/// truncated) exactly: XOR and multiply are bit-identical between i32 and
/// u32 two's-complement representations, so doing the whole computation in
/// u32 sidesteps JS's ToInt32 coercion dance without changing the result.
pub fn hash_string_to_unit(s: &str) -> f64 {
    let mut h: u32 = 2166136261;
    // JS iterates `s.charCodeAt(i)`, i.e. UTF-16 code units, not UTF-8 bytes.
    // GTFS route_short_name is free text, so non-ASCII route labels must hash
    // through the same code-unit stream to keep generated colors byte-identical
    // to colorClustering.ts.
    for unit in s.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(16777619);
    }
    (h % 10000) as f64 / 10000.0
}

/// Generate a deterministic hex color for a colorless route within the
/// mode's hue range. Uses the route's shortName as a seed so colors are
/// stable across data refreshes.
///
/// Note on TS's `hex ?? "#6b7280"` out-of-gamut fallback (colorClustering.ts
/// :92-94,106-108): this repo's `format_hex` (color_math.rs) is documented
/// to never fail for any `Rgb` input, including NaN channels — it clamps to
/// [0,1] and NaN saturates to the 0 byte on the `as u8` cast, matching
/// culori's `clamp = v => Math.max(0, Math.min(1, v || 0))` (NaN is falsy in
/// JS, so `NaN || 0` is `0`) byte-for-byte. culori's `formatHex` itself only
/// returns `undefined` when the *input color object* fails to parse/convert
/// at all (verified against culori's `src/formatter.js`
/// `serializeHex`/`formatHex` source, see color_math.rs's `format_hex` doc
/// comment) — never merely for being out-of-gamut or NaN. Since this
/// function always calls `format_hex` on a validly-typed `Rgb` produced by
/// `oklch_to_rgb` (never on a raw/unparsed string), that failure mode does
/// not apply here, so the `"#6b7280"` fallback is unreachable in the Rust
/// port and is intentionally omitted.
pub fn generate_route_color(short_name: &str, mode: &str) -> String {
    match mode_hue_range(mode) {
        None => {
            let h = hash_string_to_unit(short_name) * 360.0;
            let rgb = oklch_to_rgb(Oklch {
                l: 0.55,
                c: 0.14,
                h,
            });
            format_hex(rgb)
        }
        Some(range) => {
            let t = hash_string_to_unit(short_name);
            let hue = range.hue_start + t * (range.hue_end - range.hue_start);
            let lightness_offset = (hash_string_to_unit(&format!("{short_name}_l")) - 0.5) * 0.16;
            let l = (range.lightness + lightness_offset).clamp(0.35, 0.75);
            let rgb = oklch_to_rgb(Oklch {
                l,
                c: range.chroma,
                h: hue,
            });
            format_hex(rgb)
        }
    }
}

pub struct ColorClusterLabel {
    /// Human-readable label in English: "Bus (blue)", kept for backward compat.
    pub label: String,
    /// Structured color token ("blue", "red", ...), None when OKLCH parsing fails.
    pub color_name: Option<String>,
}

/// Name a color using simple hue-based labels. Returns both the formatted
/// label and the structured color token for i18n.
///
/// Note: `nameColorCluster` never actually hits the `undefined`-oklch
/// early-return in TS practice (`toOklch` on a valid hex string always
/// succeeds) — the Rust `parse_hex` -> `None` path below is the equivalent
/// guard, kept for parity with the TS `if (!oklch || ...)` branch even
/// though it's expected unreachable given `cluster.rs` only ever calls this
/// with `centroidHex` values it itself produced.
pub fn name_color_cluster(hex: &str, mode: &str) -> ColorClusterLabel {
    let mode_lbl = mode_label(mode).to_string();
    let Some(rgb) = parse_hex(hex) else {
        return ColorClusterLabel {
            label: mode_lbl,
            color_name: None,
        };
    };
    let oklch = rgb_to_oklch(rgb);
    let (l, c, h) = (oklch.l, oklch.c, oklch.h);

    let color_name = if l < 0.2 {
        "black"
    } else if l > 0.93 {
        "white"
    } else if c < 0.03 {
        "gray"
    } else if (0.0..40.0).contains(&h) {
        "red"
    } else if (40.0..80.0).contains(&h) {
        "orange"
    } else if (80.0..110.0).contains(&h) {
        "yellow"
    } else if (110.0..170.0).contains(&h) {
        "green"
    } else if (170.0..220.0).contains(&h) {
        "cyan"
    } else if (220.0..280.0).contains(&h) {
        "blue"
    } else if (280.0..330.0).contains(&h) {
        "purple"
    } else {
        "red"
    };

    ColorClusterLabel {
        label: format!("{mode_lbl} ({color_name})"),
        color_name: Some(color_name.to_string()),
    }
}

pub struct SubModeEntry {
    /// Unique ID: "BUS", "BUS:1a2b3c".
    pub id: String,
    /// Human-readable label: "Bus (blue)", "Bus (black)".
    pub label: String,
    /// Structured mode token (e.g. "BUS", "TRAM") for i18n label construction.
    pub label_mode: String,
    /// Structured color token (e.g. "white", "red", "blue"); None for mode-only labels.
    pub label_color: Option<String>,
    /// Parent TransportMode.
    pub parent_mode: String,
    /// Cluster centroid hex color with '#' prefix.
    pub color: String,
    /// Number of routes in this cluster.
    pub route_count: usize,
    /// Sample route short names for preview badges (up to 3).
    pub sample_routes: Vec<String>,
}

struct ColorCluster {
    centroid_hex: String,
    centroid_lab: Lab,
    route_ids: Vec<String>,
    route_short_names: Vec<String>,
}

/// Cluster route colors within a single mode.
fn cluster_colors_for_mode(
    routes: &[&ColorArtifactRoute],
    mode: &str,
    default_color: &str,
) -> (Vec<SubModeEntry>, HashMap<String, String>) {
    let mut route_map = HashMap::new();

    let colored: Vec<&&ColorArtifactRoute> = routes.iter().filter(|r| r.color.len() >= 3).collect();
    let no_color: Vec<&&ColorArtifactRoute> = routes.iter().filter(|r| r.color.len() < 3).collect();

    let mut clusters: Vec<ColorCluster> = Vec::new();
    for route in &colored {
        let hex = if route.color.starts_with('#') {
            route.color.clone()
        } else {
            format!("#{}", route.color)
        };
        let route_lab = parse_hex(&hex).map(hex_to_lab).unwrap_or_else(|| {
            eprintln!(
                "[color_artifacts::cluster] failed to parse \"{hex}\" to Lab, treating as black"
            );
            Lab {
                l: 0.0,
                a: 0.0,
                b: 0.0,
            }
        });
        let mut merged = false;
        for cluster in clusters.iter_mut() {
            if ciede2000(route_lab, cluster.centroid_lab) < MERGE_THRESHOLD {
                cluster.route_ids.push(route.id.clone());
                cluster.route_short_names.push(route.short_name.clone());
                let n = cluster.route_ids.len() as f64;
                let prev = cluster.centroid_lab;
                cluster.centroid_lab = Lab {
                    l: prev.l + (route_lab.l - prev.l) / n,
                    a: prev.a + (route_lab.a - prev.a) / n,
                    b: prev.b + (route_lab.b - prev.b) / n,
                };
                cluster.centroid_hex = format_hex(lab_to_rgb(cluster.centroid_lab));
                merged = true;
                break;
            }
        }
        if !merged {
            clusters.push(ColorCluster {
                centroid_hex: hex,
                centroid_lab: route_lab,
                route_ids: vec![route.id.clone()],
                route_short_names: vec![route.short_name.clone()],
            });
        }
    }

    // Find dominant cluster (most routes). TS: `clusters.reduce((a, b) =>
    // a.routeIds.length >= b.routeIds.length ? a : b)` — a left fold where
    // the running accumulator (`a`, i.e. the earliest-seen candidate so far)
    // is kept UNLESS the new element (`b`) has a STRICTLY greater count.
    // That means ties keep the FIRST (lowest-index) cluster. `>=` on the
    // "does the new element win" side would be backwards (last-wins on
    // ties) — the strict `>` below is what makes this a first-wins fold.
    let dominant_idx: Option<usize> = {
        let mut best: Option<usize> = None;
        for (i, c) in clusters.iter().enumerate() {
            best = match best {
                None => Some(i),
                Some(b) if c.route_ids.len() > clusters[b].route_ids.len() => Some(i),
                Some(b) => Some(b),
            };
        }
        best
    };

    // Keep clusters with >=2 routes, or single-route with deltaE>25 from dominant.
    let valid_idx: Vec<usize> = (0..clusters.len())
        .filter(|&i| {
            if clusters[i].route_ids.len() >= 2 {
                return true;
            }
            match dominant_idx {
                None => true,
                Some(d) if d == i => true,
                Some(d) => {
                    ciede2000(clusters[i].centroid_lab, clusters[d].centroid_lab)
                        > OUTLIER_THRESHOLD
                }
            }
        })
        .collect();

    // Merge rejected singletons into nearest valid cluster — TS mutates
    // `validClusters` elements in place via array-of-object-refs; Rust needs
    // index bookkeeping since `clusters` can't be split-borrowed the same way.
    let mut merged_route_ids: HashMap<usize, Vec<String>> = HashMap::new();
    let mut merged_short_names: HashMap<usize, Vec<String>> = HashMap::new();
    for i in 0..clusters.len() {
        if valid_idx.contains(&i) {
            continue;
        }
        let mut nearest = valid_idx.first().copied();
        let mut min_dist = f64::INFINITY;
        for &vi in &valid_idx {
            let d = ciede2000(clusters[i].centroid_lab, clusters[vi].centroid_lab);
            if d < min_dist {
                min_dist = d;
                nearest = Some(vi);
            }
        }
        if let Some(n) = nearest {
            merged_route_ids
                .entry(n)
                .or_default()
                .extend(clusters[i].route_ids.clone());
            merged_short_names
                .entry(n)
                .or_default()
                .extend(clusters[i].route_short_names.clone());
        }
    }

    let mut results: Vec<SubModeEntry> = Vec::new();
    let default_id = mode.to_string();

    if no_color.len() >= NO_COLOR_PALETTE_THRESHOLD && valid_idx.is_empty() {
        // Many colorless routes and no real color data: generate varied
        // colors and cluster them the same way we cluster real colors.
        let mut synthetic: Vec<ColorCluster> = Vec::new();
        for route in &no_color {
            let hex = generate_route_color(&route.short_name, mode);
            let mut merged = false;
            for cluster in synthetic.iter_mut() {
                // colorClustering.ts uses the wrapper `ciede2000(hex, hex)`
                // (re-parses both to Lab each call) here, NOT the shared
                // Lab-object `ciede2000Diff` used above — same math,
                // different call surface: culori has no direct RGB->XYZ65
                // conversion (color_math.rs's `xyz65_to_rgb` doc comment),
                // so both paths route through the identical
                // XYZ50->Bradford->XYZ65 hop internally. `ciede2000` in
                // this Rust port takes Lab, not hex, so parse both sides.
                if let (Some(a), Some(b)) = (parse_hex(&hex), parse_hex(&cluster.centroid_hex)) {
                    if ciede2000(hex_to_lab(a), hex_to_lab(b)) < MERGE_THRESHOLD {
                        cluster.route_ids.push(route.id.clone());
                        cluster.route_short_names.push(route.short_name.clone());
                        merged = true;
                        break;
                    }
                }
            }
            if !merged {
                let lab = parse_hex(&hex).map(hex_to_lab).unwrap_or(Lab {
                    l: 0.0,
                    a: 0.0,
                    b: 0.0,
                });
                synthetic.push(ColorCluster {
                    centroid_hex: hex,
                    centroid_lab: lab,
                    route_ids: vec![route.id.clone()],
                    route_short_names: vec![route.short_name.clone()],
                });
            }
        }
        for cluster in &synthetic {
            let id = format!(
                "{mode}:{}",
                cluster.centroid_hex.trim_start_matches('#').to_lowercase()
            );
            let named = name_color_cluster(&cluster.centroid_hex, mode);
            results.push(SubModeEntry {
                id: id.clone(),
                label: named.label,
                label_mode: mode.to_string(),
                label_color: named.color_name,
                parent_mode: mode.to_string(),
                color: cluster.centroid_hex.clone(),
                route_count: cluster.route_ids.len(),
                sample_routes: cluster.route_short_names.iter().take(3).cloned().collect(),
            });
            for rid in &cluster.route_ids {
                route_map.insert(rid.clone(), id.clone());
            }
        }
    } else if !no_color.is_empty() || valid_idx.is_empty() {
        // Few colorless routes or there are also colored clusters: assign
        // them all the same default color (original behavior).
        let route_count = if !no_color.is_empty() {
            no_color.len()
        } else if valid_idx.is_empty() {
            routes.len()
        } else {
            0
        };
        results.push(SubModeEntry {
            id: default_id.clone(),
            label: mode_label(mode).to_string(),
            label_mode: mode.to_string(),
            label_color: None,
            parent_mode: mode.to_string(),
            color: default_color.to_string(),
            route_count,
            sample_routes: no_color
                .iter()
                .take(3)
                .map(|r| r.short_name.clone())
                .collect(),
        });
        for r in &no_color {
            route_map.insert(r.id.clone(), default_id.clone());
        }
        if valid_idx.is_empty() {
            for r in &colored {
                route_map.insert(r.id.clone(), default_id.clone());
            }
        }
    }

    // Add color clusters and build route->subMode mapping from cluster membership.
    for &i in &valid_idx {
        let mut ids = clusters[i].route_ids.clone();
        ids.extend(merged_route_ids.remove(&i).unwrap_or_default());
        let mut names = clusters[i].route_short_names.clone();
        names.extend(merged_short_names.remove(&i).unwrap_or_default());

        let is_sole = valid_idx.len() == 1 && no_color.is_empty();
        let id = if is_sole {
            mode.to_string()
        } else {
            format!(
                "{mode}:{}",
                clusters[i]
                    .centroid_hex
                    .trim_start_matches('#')
                    .to_lowercase()
            )
        };
        let (label, color_name) = if is_sole {
            (mode_label(mode).to_string(), None)
        } else {
            let named = name_color_cluster(&clusters[i].centroid_hex, mode);
            (named.label, named.color_name)
        };

        results.push(SubModeEntry {
            id: id.clone(),
            label,
            label_mode: mode.to_string(),
            label_color: color_name,
            parent_mode: mode.to_string(),
            color: clusters[i].centroid_hex.clone(),
            route_count: ids.len(),
            sample_routes: names.iter().take(3).cloned().collect(),
        });
        for rid in &ids {
            route_map.insert(rid.clone(), id.clone());
        }
    }

    // TS: `results.sort((a,b) => b.routeCount - a.routeCount)` — Array.prototype.sort
    // is stable per spec (ES2019+); Rust's `sort_by_key` is ALSO stable —
    // use `sort_by_key` (not `sort_unstable_by_key`) to preserve this.
    results.sort_by_key(|e| std::cmp::Reverse(e.route_count));

    (results, route_map)
}

pub struct ClusterResult {
    pub sub_modes: Vec<SubModeEntry>,
    pub route_sub_mode_map: HashMap<String, String>,
}

/// Port of colorClustering.ts's `clusterRouteColors`. Groups by mode (TS
/// uses a `Map`, insertion-ordered by first-seen mode); `allSubModes`
/// concatenation order depends on mode-group iteration order, so this uses
/// an order-preserving `IndexMap` keyed by first-seen mode rather than a
/// `HashMap`.
pub fn cluster_route_colors(routes: &[ColorArtifactRoute]) -> ClusterResult {
    let mut by_mode: IndexMap<&str, Vec<&ColorArtifactRoute>> = IndexMap::new();
    for r in routes {
        by_mode.entry(r.mode).or_default().push(r);
    }

    let mut all_sub_modes = Vec::new();
    let mut route_sub_mode_map = HashMap::new();

    for (&mode, mode_routes) in &by_mode {
        let default_color = default_mode_color(mode);
        let (sub_modes, route_map) = cluster_colors_for_mode(mode_routes, mode, default_color);
        all_sub_modes.extend(sub_modes);
        for (k, v) in route_map {
            route_sub_mode_map.insert(k, v);
        }
    }

    ClusterResult {
        sub_modes: all_sub_modes,
        route_sub_mode_map,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(id: &str, short_name: &str, mode: &'static str, color: &str) -> ColorArtifactRoute {
        ColorArtifactRoute {
            id: id.to_string(),
            short_name: short_name.to_string(),
            color: color.to_string(),
            mode,
        }
    }

    // --- hashStringToUnit / generateRouteColor -----------------------------

    #[test]
    fn hash_string_to_unit_is_in_unit_range_and_deterministic() {
        for s in ["1", "42", "100", "A", "Tram 7", ""] {
            let v = hash_string_to_unit(s);
            assert!((0.0..1.0).contains(&v), "s={s} v={v}");
        }
        assert_eq!(hash_string_to_unit("42"), hash_string_to_unit("42"));
        assert_eq!(hash_string_to_unit("abc"), hash_string_to_unit("abc"));
    }

    #[test]
    fn hash_string_to_unit_matches_js_charcodeat_for_non_ascii() {
        // Expected values from colorClustering.ts's exact loop:
        // let h=2166136261; for (i) { h ^= s.charCodeAt(i); h=Math.imul(h,16777619); }
        // return ((h >>> 0) % 10000) / 10000;
        for (s, expected) in [("Ž", 0.1432), ("１", 0.3724), ("Маршрут", 0.0326)] {
            let got = hash_string_to_unit(s);
            assert!(
                (got - expected).abs() < 1e-12,
                "s={s} got={got} want={expected}"
            );
        }
    }

    #[test]
    fn generate_route_color_is_deterministic_and_well_formed() {
        let a = generate_route_color("10", "BUS");
        let b = generate_route_color("10", "BUS");
        assert_eq!(a, b);
        assert_eq!(a.len(), 7);
        assert!(a.starts_with('#'));

        // Unknown mode falls through the `None` branch and still yields a
        // well-formed hex color.
        let walk = generate_route_color("42", "WALK");
        assert_eq!(walk.len(), 7);
        assert!(walk.starts_with('#'));
    }

    // --- nameColorCluster ----------------------------------------------------

    #[test]
    fn name_color_cluster_labels_known_colors() {
        let blue = name_color_cluster("#1d4ed8", "BUS");
        assert_eq!(blue.label, "Bus (blue)");
        assert_eq!(blue.color_name.as_deref(), Some("blue"));

        let green = name_color_cluster("#16a34a", "TRAM");
        assert_eq!(green.label, "Tram (green)");
        assert_eq!(green.color_name.as_deref(), Some("green"));

        let black = name_color_cluster("#000000", "BUS");
        assert_eq!(black.color_name.as_deref(), Some("black"));
    }

    // --- clusterRouteColors: 2 similar colors merging into a cluster --------

    #[test]
    fn similar_colors_merge_into_shared_clusters() {
        // Mirrors colorClustering.test.ts "preserves original behavior for
        // routes with colors": 2 reds + 2 greens -> 2 sub-modes, all 4 routes
        // mapped.
        let routes = vec![
            route("r1", "1", "BUS", "ff0000"),
            route("r2", "2", "BUS", "ff1111"),
            route("r3", "3", "BUS", "00ff00"),
            route("r4", "4", "BUS", "00ee00"),
        ];
        let result = cluster_route_colors(&routes);
        assert_eq!(result.route_sub_mode_map.len(), 4);
        assert_eq!(result.sub_modes.len(), 2);
        for r in &routes {
            assert!(result.route_sub_mode_map.contains_key(&r.id));
        }
    }

    #[test]
    fn identical_colors_form_a_single_sole_sub_mode() {
        let routes = vec![
            route("r1", "1", "TRAM", "16a34a"),
            route("r2", "2", "TRAM", "16a34a"),
            route("r3", "3", "TRAM", "16a34a"),
        ];
        let result = cluster_route_colors(&routes);
        assert_eq!(result.sub_modes.len(), 1);
        assert_eq!(result.sub_modes[0].id, "TRAM");
    }

    // --- outlier route staying separate --------------------------------------

    #[test]
    fn outlier_route_stays_separate_from_dominant_cluster() {
        // 3 near-identical reds form a dominant 3-route cluster; a distinct
        // blue route is far enough (deltaE>25) from the dominant centroid to
        // survive as its own singleton sub-mode instead of being folded in.
        let routes = vec![
            route("r1", "1", "BUS", "ff0000"),
            route("r2", "2", "BUS", "ff0000"),
            route("r3", "3", "BUS", "ff0000"),
            route("r4", "4", "BUS", "0000ff"),
        ];

        // Precondition sanity check on the actual deltaE, so this test fails
        // loudly (not mysteriously) if the fixture colors ever need tuning.
        let red_lab = hex_to_lab(parse_hex("#ff0000").unwrap());
        let blue_lab = hex_to_lab(parse_hex("#0000ff").unwrap());
        let d = ciede2000(red_lab, blue_lab);
        assert!(
            d > OUTLIER_THRESHOLD,
            "expected red/blue deltaE>25, got {d}"
        );

        let result = cluster_route_colors(&routes);
        assert_eq!(result.sub_modes.len(), 2);
        assert_eq!(result.route_sub_mode_map.len(), 4);

        let dominant = result
            .sub_modes
            .iter()
            .find(|sm| sm.route_count == 3)
            .unwrap();
        let outlier = result
            .sub_modes
            .iter()
            .find(|sm| sm.route_count == 1)
            .unwrap();
        assert_eq!(dominant.color, "#ff0000");
        assert_eq!(outlier.color, "#0000ff");
        assert_eq!(result.route_sub_mode_map.get("r4"), Some(&outlier.id));
    }

    // --- colorless-routes-generate-synthetic-palette path (threshold boundary) --

    #[test]
    fn colorless_routes_below_threshold_get_the_default_color() {
        // 3 colorless routes: below NO_COLOR_PALETTE_THRESHOLD (4) -> single
        // default-colored sub-mode.
        let routes = vec![
            route("r1", "1", "BUS", ""),
            route("r2", "2", "BUS", ""),
            route("r3", "3", "BUS", ""),
        ];
        let result = cluster_route_colors(&routes);
        assert_eq!(result.sub_modes.len(), 1);
        assert_eq!(result.sub_modes[0].color, "#1d4ed8");
        assert_eq!(result.sub_modes[0].id, "BUS");
        assert_eq!(result.sub_modes[0].label_color, None);
    }

    #[test]
    fn colorless_routes_at_exactly_the_threshold_generate_a_synthetic_palette() {
        // Mirrors colorClustering.test.ts "generates varied colors at
        // exactly the threshold (4 colorless routes)".
        let routes: Vec<ColorArtifactRoute> = (0..NO_COLOR_PALETTE_THRESHOLD)
            .map(|i| route(&format!("r{i}"), &(i + 1).to_string(), "BUS", ""))
            .collect();
        let result = cluster_route_colors(&routes);
        assert!(
            result.sub_modes.len() > 1,
            "expected >1 sub-mode, got {}",
            result.sub_modes.len()
        );
        assert_eq!(result.route_sub_mode_map.len(), NO_COLOR_PALETTE_THRESHOLD);
        for sm in &result.sub_modes {
            assert_eq!(sm.parent_mode, "BUS");
            assert!(sm.id.starts_with("BUS:"));
            assert!(sm.color.starts_with('#'));
        }
        let total: usize = result.sub_modes.iter().map(|sm| sm.route_count).sum();
        assert_eq!(total, NO_COLOR_PALETTE_THRESHOLD);
    }

    #[test]
    fn colorless_routes_use_default_when_colored_clusters_exist() {
        // Mirrors "uses default for colorless routes even when many, if
        // colored clusters exist": 5 colorless routes (above threshold) but
        // 2 colored routes form a valid cluster, so colorless routes still
        // fall back to the default id/color rather than getting a synthetic
        // palette.
        let mut routes = vec![
            route("c1", "C1", "BUS", "ff0000"),
            route("c2", "C2", "BUS", "ff1100"),
        ];
        for i in 0..5 {
            routes.push(route(&format!("nc{i}"), &format!("NC{i}"), "BUS", ""));
        }
        let result = cluster_route_colors(&routes);
        for i in 0..5 {
            assert_eq!(
                result
                    .route_sub_mode_map
                    .get(&format!("nc{i}"))
                    .map(String::as_str),
                Some("BUS")
            );
        }
    }

    // --- tie-break-on-dominant-cluster (first-wins on a routeIds.length tie) ----

    #[test]
    fn dominant_cluster_tie_break_keeps_the_first_seen_cluster() {
        // Two BUS routes with distinct colors, each forming its own
        // singleton cluster (deltaE between them > MERGE_THRESHOLD so they
        // don't merge, but < OUTLIER_THRESHOLD so neither survives as an
        // independent outlier once one of them is *not* dominant). Both
        // clusters tie at routeIds.length == 1, so TS's
        // `reduce((a,b) => a.length>=b.length?a:b)` keeps the FIRST cluster
        // (r1's, "#ff0000") as dominant; the second singleton then fails the
        // outlier check against it and gets folded in. A last-wins fold
        // would instead keep r2's cluster dominant and fold r1's away,
        // flipping which color survives as the merged sub-mode's centroid.
        let hex_a = "#ff0000";
        let hex_b = "#e08030";
        let lab_a = hex_to_lab(parse_hex(hex_a).unwrap());
        let lab_b = hex_to_lab(parse_hex(hex_b).unwrap());
        let d = ciede2000(lab_a, lab_b);
        assert!(
            d > MERGE_THRESHOLD && d < OUTLIER_THRESHOLD,
            "fixture colors must sit strictly between the merge and outlier thresholds, got d={d}"
        );

        let routes = vec![
            route("r1", "1", "BUS", &hex_a[1..]),
            route("r2", "2", "BUS", &hex_b[1..]),
        ];
        let result = cluster_route_colors(&routes);

        assert_eq!(
            result.sub_modes.len(),
            1,
            "both singletons should merge into one sole sub-mode"
        );
        let sm = &result.sub_modes[0];
        assert_eq!(sm.route_count, 2);
        assert_eq!(
            sm.color, hex_a,
            "first-seen cluster (r1's color) must remain the dominant centroid"
        );
        assert_eq!(result.route_sub_mode_map.get("r1"), Some(&sm.id));
        assert_eq!(result.route_sub_mode_map.get("r2"), Some(&sm.id));
    }

    // --- structured labelMode / labelColor fields ----------------------------

    #[test]
    fn sole_cluster_has_no_label_color() {
        let routes = vec![route("r1", "1", "BUS", "ff0000")];
        let result = cluster_route_colors(&routes);
        assert_eq!(result.sub_modes.len(), 1);
        let sm = &result.sub_modes[0];
        assert_eq!(sm.label_mode, "BUS");
        assert_eq!(sm.label_color, None);
    }

    #[test]
    fn per_cluster_entries_carry_label_mode_and_label_color() {
        let routes = vec![
            route("r1", "1", "BUS", "ff0000"),
            route("r2", "2", "BUS", "ff1111"),
            route("r3", "3", "BUS", "00ff00"),
            route("r4", "4", "BUS", "00ee00"),
        ];
        let result = cluster_route_colors(&routes);
        assert_eq!(result.sub_modes.len(), 2);
        let mut color_names: Vec<&str> = result
            .sub_modes
            .iter()
            .map(|sm| {
                assert_eq!(sm.label_mode, "BUS");
                sm.label_color.as_deref().unwrap()
            })
            .collect();
        color_names.sort_unstable();
        assert_eq!(color_names, vec!["green", "red"]);
    }

    #[test]
    fn label_mode_matches_parent_mode_across_mixed_modes() {
        let routes = vec![
            route("b1", "B1", "BUS", "ff0000"),
            route("t1", "T1", "TRAM", "16a34a"),
        ];
        let result = cluster_route_colors(&routes);
        for sm in &result.sub_modes {
            assert_eq!(sm.label_mode, sm.parent_mode);
        }
    }

    #[test]
    fn mode_group_order_is_first_seen_order() {
        // clusterRouteColors groups by mode using an insertion-ordered map;
        // verify TRAM (seen first) precedes BUS in the concatenated output
        // even though BUS would sort first alphabetically.
        let routes = vec![
            route("t1", "1", "TRAM", "16a34a"),
            route("b1", "1", "BUS", "1d4ed8"),
            route("t2", "2", "TRAM", "16a34a"),
        ];
        let result = cluster_route_colors(&routes);
        let modes: Vec<&str> = result
            .sub_modes
            .iter()
            .map(|sm| sm.parent_mode.as_str())
            .collect();
        assert_eq!(modes, vec!["TRAM", "BUS"]);
    }
}
