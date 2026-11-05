//! JSON wire structs matching color-artifacts-gen.mjs's three emit() calls
//! byte-for-byte. Field order below = struct declaration order = JS object
//! literal property order, verified directly against
//! packages/backend/src/gtfs/colorClustering.ts's `results.push({...})`
//! call sites (colorClustering.ts:270-278, :287-295, :320-329),
//! packages/backend/src/gtfs/colorblindPalettes.ts's `computePalettes`
//! return construction (colorblindPalettes.ts:237-249), and
//! color-artifacts-gen.mjs itself (the emit() call sites for
//! color-config.json / route-styles.json / label-anchors.json) — NOT
//! against packages/shared/src/types/colorConfig.ts's `SubModeEntry`
//! *interface* declaration order, which is irrelevant to runtime
//! `JSON.stringify` key order (only actual object-literal property-write
//! order matters; TS interfaces have no runtime representation). The two
//! happen to agree here, but the interface was not the source of truth
//! used to derive this file.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::Serialize;

use super::cluster::SubModeEntry;
use super::inputs::ColorArtifactRoute;
use super::palettes::{PalettesResult, ThemePalettes};
use crate::schedule_tiles::js_key_order::reordered_like_js_object_keys;

/// Matches colorClustering.ts's `results.push({...})` object-literal
/// property order verbatim — all three push sites (colorClustering.ts:270,
/// :287, :320) write `id, label, labelMode, labelColor, parentMode, color,
/// routeCount, sampleRoutes` in that order (the "no color" default-mode
/// branch at :287 omits `labelColor` entirely rather than writing
/// `labelColor: undefined`, but `JSON.stringify` drops `undefined`-valued
/// keys either way, so both call-site shapes produce identical JSON — see
/// `#[serde(skip_serializing_if)]` below).
#[derive(Serialize)]
pub struct WireSubMode {
    pub id: String,
    pub label: String,
    #[serde(rename = "labelMode")]
    pub label_mode: String,
    #[serde(rename = "labelColor", skip_serializing_if = "Option::is_none")]
    pub label_color: Option<String>,
    #[serde(rename = "parentMode")]
    pub parent_mode: String,
    pub color: String,
    #[serde(rename = "routeCount")]
    pub route_count: usize,
    #[serde(rename = "sampleRoutes")]
    pub sample_routes: Vec<String>,
}

impl From<&SubModeEntry> for WireSubMode {
    fn from(e: &SubModeEntry) -> Self {
        WireSubMode {
            id: e.id.clone(),
            label: e.label.clone(),
            label_mode: e.label_mode.clone(),
            label_color: e.label_color.clone(),
            parent_mode: e.parent_mode.clone(),
            color: e.color.clone(),
            route_count: e.route_count,
            sample_routes: e.sample_routes.clone(),
        }
    }
}

/// Matches colorblindPalettes.ts's `ThemePalettes` object-literal
/// construction (colorblindPalettes.ts:237-239 for `light`, :241-247 for
/// `dark`): `universal, deuteranopia, protanopia, tritanopia, highContrast`
/// in that field order, for both themes.
#[derive(Serialize)]
pub struct WirePaletteSet {
    pub universal: IndexMap<String, String>,
    pub deuteranopia: IndexMap<String, String>,
    pub protanopia: IndexMap<String, String>,
    pub tritanopia: IndexMap<String, String>,
    #[serde(rename = "highContrast")]
    pub high_contrast: IndexMap<String, String>,
}

fn wire_palette_set(theme: &ThemePalettes) -> WirePaletteSet {
    WirePaletteSet {
        universal: theme.universal.clone(),
        deuteranopia: theme.deuteranopia.clone(),
        protanopia: theme.protanopia.clone(),
        tritanopia: theme.tritanopia.clone(),
        high_contrast: theme.high_contrast.clone(),
    }
}

#[derive(Serialize)]
pub struct WirePalettes {
    pub light: WirePaletteSet,
    pub dark: WirePaletteSet,
}

/// Matches color-artifacts-gen.mjs's `colorConfig = { modes: subModes,
/// palettes: { light, dark }, universalLimited }` — top-level key order
/// `modes, palettes, universalLimited`; `palettes` nests `{ light, dark }`.
#[derive(Serialize)]
pub struct WireColorConfig {
    pub modes: Vec<WireSubMode>,
    pub palettes: WirePalettes,
    #[serde(rename = "universalLimited")]
    pub universal_limited: bool,
}

/// route-styles.json element — matches color-artifacts-gen.mjs's
/// `routeStyles[r.id] = { color, textColor, subMode }`.
#[derive(Serialize)]
pub struct WireRouteStyle {
    pub color: String,
    #[serde(rename = "textColor")]
    pub text_color: String,
    #[serde(rename = "subMode")]
    pub sub_mode: String,
}

/// Encode color-config.json.
///
/// `palettes.light/dark.*` key order (sub-mode id -> hex) is NOT passed
/// through `reordered_like_js_object_keys`, unlike `encode_route_styles`/
/// `encode_label_anchors` below. Sub-mode ids are always `"<MODE>"` or
/// `"<MODE>:<hex>"` (cluster.rs's `default_id` / synthetic-cluster `id`
/// construction), and `<MODE>` tokens (routeTypeToMode's output — see
/// schedule_tiles/mode.rs) are always alphabetic ("BUS", "TRAM", ...), so
/// no sub-mode id can ever be a canonical JS array-index string. Applying
/// the reorder here would be a correctness no-op; it is intentionally
/// omitted to keep the no-op-ness self-evident rather than silently
/// relying on an invariant elsewhere.
pub fn encode_color_config(sub_modes: &[SubModeEntry], palettes: &PalettesResult) -> Vec<u8> {
    let wire = WireColorConfig {
        modes: sub_modes.iter().map(WireSubMode::from).collect(),
        palettes: WirePalettes {
            light: wire_palette_set(&palettes.light),
            dark: wire_palette_set(&palettes.dark),
        },
        universal_limited: palettes.universal_limited,
    };
    serde_json::to_vec(&wire).expect("color-config wire serialization is infallible")
}

/// Port of color-artifacts-gen.mjs's top-of-file `contrastTextColor` (WCAG
/// relative luminance, 0.179 cutoff — same formula as store.ts's private
/// copy and crates/pt-serve, per that function's own "no mechanical link —
/// the pt-serve-route-parity gate enforces sync" comment).
pub fn contrast_text_color(hex: &str) -> &'static str {
    let Some(rgb) = super::color_math::parse_hex(hex) else {
        return "#ffffff";
    };
    let lin = |c: f64| {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let l = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    if l > 0.179 {
        "#000000"
    } else {
        "#ffffff"
    }
}

/// Encode route-styles.json. Port of color-artifacts-gen.mjs's
/// `routeStyles` construction loop.
///
/// Takes `sub_modes` directly rather than a pre-built id->color map, so a
/// future caller can pass `ClusterResult.sub_modes` straight through —
/// mirroring gen.mjs's own `const subModeById = new Map(subModes.map((sm)
/// => [sm.id, sm]));` one-to-one instead of pushing an extra map-building
/// step onto every call site.
pub fn encode_route_styles(
    routes: &[ColorArtifactRoute],
    route_sub_mode_map: &HashMap<String, String>,
    sub_modes: &[SubModeEntry],
) -> Vec<u8> {
    let color_by_sub_mode_id: HashMap<&str, &str> = sub_modes
        .iter()
        .map(|sm| (sm.id.as_str(), sm.color.as_str()))
        .collect();

    let mut styles: IndexMap<String, WireRouteStyle> = IndexMap::new();
    for r in routes {
        // JS: `const sm = routeSubModeMap.get(r.id); const entry =
        // subModeById.get(sm ?? "");` — if `sm` is undefined, this looks up
        // the literal key `""`, which is never a real sub-mode id (ids are
        // always non-empty per the doc above), so it's always a miss —
        // behaviorally identical to `sm.and_then(...)` short-circuiting on
        // `None` without ever touching the map.
        let sm = route_sub_mode_map.get(&r.id);
        let entry_color = sm.and_then(|s| color_by_sub_mode_id.get(s.as_str()));
        let normalized = entry_color.map(|c| c.to_string()).unwrap_or_else(|| {
            if !r.color.is_empty() {
                format!("#{}", r.color)
            } else {
                String::new()
            }
        });
        let text_color = if contrast_text_color(&normalized) == "#000000" {
            "000000"
        } else {
            "FFFFFF"
        };
        styles.insert(
            r.id.clone(),
            WireRouteStyle {
                // JS: `normalized.replace(/^#/, "")` strips exactly ONE
                // leading '#' (anchored, non-global regex). `strip_prefix`
                // is the byte-identical primitive for that —
                // `trim_start_matches('#')` would strip a whole run of
                // leading '#'s instead, which is a different operation (it
                // can't currently diverge given `normalized` is always
                // either "" or exactly one '#'-prefixed hex string per
                // `ColorArtifactRoute::color`'s and `SubModeEntry::color`'s
                // own doc contracts, but `strip_prefix` is correct
                // regardless of that invariant holding).
                color: normalized
                    .strip_prefix('#')
                    .unwrap_or(&normalized)
                    .to_string(),
                text_color: text_color.to_string(),
                sub_mode: sm.cloned().unwrap_or_else(|| r.mode.to_string()),
            },
        );
    }

    // route-styles.json is a plain JS object keyed by GTFS route_id, which
    // GTFS permits to be numeric-looking ("42") — subject to JS
    // OrdinaryOwnPropertyKeys enumeration (canonical array-index keys
    // enumerate first, ascending numeric, ahead of all other keys) once
    // `JSON.stringify` walks its own keys. See
    // `schedule_tiles::js_key_order`'s module doc for the empirical V8
    // repro this replicates.
    let reordered = reordered_like_js_object_keys(&styles);
    serde_json::to_vec(&reordered).expect("route-styles wire serialization is infallible")
}

/// Encode label-anchors.json.
pub fn encode_label_anchors(anchors: &IndexMap<String, &'static str>) -> Vec<u8> {
    // color-artifacts-gen.mjs does `Object.fromEntries(anchors)` where
    // `anchors` is the Map `computeLabelAnchors` returned, in Map
    // INSERTION order (== PTB stop order, per anchors.rs's
    // `compute_label_anchors` doc). `Object.fromEntries` builds its result
    // via ordinary `[[DefineOwnProperty]]` in Map-iteration order, but the
    // resulting plain object is STILL subject to JS
    // OrdinaryOwnPropertyKeys enumeration once `JSON.stringify` walks its
    // keys afterward — a numeric-looking GTFS stop_id ("7") enumerates
    // ahead of non-numeric ids regardless of the Map's insertion order.
    // Apply the same reordering `encode_route_styles` uses.
    let reordered = reordered_like_js_object_keys(anchors);
    serde_json::to_vec(&reordered).expect("label-anchors wire serialization is infallible")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub_mode_entry(
        id: &str,
        label: &str,
        label_mode: &str,
        label_color: Option<&str>,
        parent_mode: &str,
        color: &str,
        route_count: usize,
        sample_routes: &[&str],
    ) -> SubModeEntry {
        SubModeEntry {
            id: id.to_string(),
            label: label.to_string(),
            label_mode: label_mode.to_string(),
            label_color: label_color.map(str::to_string),
            parent_mode: parent_mode.to_string(),
            color: color.to_string(),
            route_count,
            sample_routes: sample_routes.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Builds one theme's 5 palette-variant maps as `{key: "#<prefix><tag><i>"}`
    /// (decimal, zero-padded to 2 digits) for `i` = each key's position in
    /// `keys` — matches the regeneration script's `variant` helper exactly
    /// (`String(i).padStart(2, "0")`, decimal, not hex).
    fn theme_palettes(prefix: &str, keys: &[&str]) -> ThemePalettes {
        let variant = |tag: &str| -> IndexMap<String, String> {
            keys.iter()
                .enumerate()
                .map(|(i, k)| (k.to_string(), format!("#{prefix}{tag}{i:02}")))
                .collect()
        };
        ThemePalettes {
            universal: variant("1"),
            deuteranopia: variant("2"),
            protanopia: variant("3"),
            tritanopia: variant("4"),
            high_contrast: variant("5"),
        }
    }

    // --- color-config.json ---------------------------------------------

    /// Golden fixture generated from an equivalent hand-built JS object via
    /// real `JSON.stringify` (regeneration script below — run with plain
    /// `node`, no build required). Hand-fed data mirrors the Rust literal
    /// below field-for-field; only `wire.rs`'s SERIALIZATION is under test
    /// here, not cluster.rs/palettes.rs's VALUES (those are covered by
    /// Tasks 4/5's own golden tests against real culori/TS).
    ///
    /// Regeneration command (`node color_config_golden.mjs > \
    /// color_artifacts_golden_color_config.json`):
    /// ```js
    /// const subModes = [
    ///   { id: "BUS:1a2b3c", label: "Bus (blue)", labelMode: "BUS", labelColor: "blue", parentMode: "BUS", color: "#1a2b3c", routeCount: 5, sampleRoutes: ["1", "2", "3"] },
    ///   { id: "TRAM", label: "Tram", labelMode: "TRAM", parentMode: "TRAM", color: "#16a34a", routeCount: 2, sampleRoutes: ["7"] },
    ///   { id: "METRO:dc2626", label: "Metro (red)", labelMode: "METRO", labelColor: "red", parentMode: "METRO", color: "#dc2626", routeCount: 1, sampleRoutes: [] },
    /// ];
    /// const keys = ["TRAM", "BUS:1a2b3c", "METRO:dc2626"];
    /// const variant = (tag) => Object.fromEntries(keys.map((k, i) => [k, `#${tag}${String(i).padStart(2, "0")}`]));
    /// const themePalettes = (prefix) => ({
    ///   universal: variant(`${prefix}1`), deuteranopia: variant(`${prefix}2`),
    ///   protanopia: variant(`${prefix}3`), tritanopia: variant(`${prefix}4`),
    ///   highContrast: variant(`${prefix}5`),
    /// });
    /// const colorConfig = {
    ///   modes: subModes,
    ///   palettes: { light: themePalettes("l"), dark: themePalettes("d") },
    ///   universalLimited: true,
    /// };
    /// process.stdout.write(JSON.stringify(colorConfig));
    /// ```
    #[test]
    fn encode_color_config_matches_node_golden() {
        let sub_modes = vec![
            sub_mode_entry(
                "BUS:1a2b3c",
                "Bus (blue)",
                "BUS",
                Some("blue"),
                "BUS",
                "#1a2b3c",
                5,
                &["1", "2", "3"],
            ),
            sub_mode_entry("TRAM", "Tram", "TRAM", None, "TRAM", "#16a34a", 2, &["7"]),
            sub_mode_entry(
                "METRO:dc2626",
                "Metro (red)",
                "METRO",
                Some("red"),
                "METRO",
                "#dc2626",
                1,
                &[],
            ),
        ];

        let keys = ["TRAM", "BUS:1a2b3c", "METRO:dc2626"];
        let palettes = PalettesResult {
            light: theme_palettes("l", &keys),
            dark: theme_palettes("d", &keys),
            universal_limited: true,
        };

        let got = encode_color_config(&sub_modes, &palettes);
        let expected =
            include_bytes!("../../tests/fixtures/color_artifacts_golden_color_config.json");
        assert_eq!(got, expected.to_vec());
    }

    /// Pins JSON escaping for `WireSubMode` string fields: quote,
    /// backslash, tab, newline, and a non-named control char (0x01, which
    /// `JSON.stringify` renders as `\u0001`, not a named escape — only
    /// 0x08/0x09/0x0A/0x0C/0x0D have named escapes). Mirrors
    /// schedule_tiles/wire.rs's `encode_matches_node_golden_escapes`.
    ///
    /// Regeneration:
    /// ```js
    /// const subModes = [{ id: "BUS", label: 'a"b\\c\td\ne\u0001f', labelMode: "BUS", parentMode: "BUS", color: "#ffffff", routeCount: 1, sampleRoutes: [] }];
    /// const empty = {};
    /// const colorConfig = {
    ///   modes: subModes,
    ///   palettes: { light: { universal: empty, deuteranopia: empty, protanopia: empty, tritanopia: empty, highContrast: empty },
    ///               dark: { universal: empty, deuteranopia: empty, protanopia: empty, tritanopia: empty, highContrast: empty } },
    ///   universalLimited: false,
    /// };
    /// process.stdout.write(JSON.stringify(colorConfig));
    /// ```
    #[test]
    fn encode_color_config_matches_node_golden_escapes() {
        let sub_modes = vec![sub_mode_entry(
            "BUS",
            "a\"b\\c\td\ne\u{1}f",
            "BUS",
            None,
            "BUS",
            "#ffffff",
            1,
            &[],
        )];
        let empty_theme = || ThemePalettes {
            universal: IndexMap::new(),
            deuteranopia: IndexMap::new(),
            protanopia: IndexMap::new(),
            tritanopia: IndexMap::new(),
            high_contrast: IndexMap::new(),
        };
        let palettes = PalettesResult {
            light: empty_theme(),
            dark: empty_theme(),
            universal_limited: false,
        };

        let got = encode_color_config(&sub_modes, &palettes);
        let expected =
            include_bytes!("../../tests/fixtures/color_artifacts_golden_color_config_escapes.json");
        assert_eq!(got, expected.to_vec());
    }

    // --- route-styles.json -----------------------------------------------

    fn route(id: &str, color: &str, mode: &'static str) -> ColorArtifactRoute {
        ColorArtifactRoute {
            id: id.to_string(),
            short_name: String::new(),
            color: color.to_string(),
            mode,
        }
    }

    /// Golden fixture covering all three `routeStyles[r.id] = {...}`
    /// resolution paths: R1 resolves through `routeSubModeMap` +
    /// `subModeById` to a real sub-mode's color; R2 has no
    /// `routeSubModeMap` entry and falls through to its own `color`/`mode`;
    /// R3 HAS a `routeSubModeMap` entry but that id isn't in `subModes`
    /// (`entry` is `undefined`), so it also falls through to its own
    /// `color` (here empty, so `normalized` ends up `""`) while still
    /// reporting `subMode` as the (unresolvable) mapped id rather than
    /// `r.mode` — pins the `sm ?? r.mode` vs `entry?.color ?? ...`
    /// short-circuit distinction.
    ///
    /// Regeneration:
    /// ```js
    /// function contrastTextColor(hex) {
    ///   const h = hex.startsWith("#") ? hex.slice(1) : hex;
    ///   if (h.length < 6) return "#ffffff";
    ///   const r = parseInt(h.slice(0, 2), 16) / 255;
    ///   const g = parseInt(h.slice(2, 4), 16) / 255;
    ///   const b = parseInt(h.slice(4, 6), 16) / 255;
    ///   const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    ///   const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    ///   return L > 0.179 ? "#000000" : "#ffffff";
    /// }
    /// const routeInputs = [
    ///   { id: "R1", color: "ff0000", mode: "BUS" },
    ///   { id: "R2", color: "00ff00", mode: "TRAM" },
    ///   { id: "R3", color: "", mode: "METRO" },
    /// ];
    /// const routeSubModeMap = new Map([["R1", "BUS:1a2b3c"], ["R3", "GHOST"]]);
    /// const subModeById = new Map([["BUS:1a2b3c", { color: "#1a2b3c" }]]);
    /// const routeStyles = {};
    /// for (const r of routeInputs) {
    ///   const sm = routeSubModeMap.get(r.id);
    ///   const entry = subModeById.get(sm ?? "");
    ///   const normalized = entry?.color ?? (r.color ? `#${r.color}` : "");
    ///   routeStyles[r.id] = {
    ///     color: normalized.replace(/^#/, ""),
    ///     textColor: contrastTextColor(normalized) === "#000000" ? "000000" : "FFFFFF",
    ///     subMode: sm ?? r.mode,
    ///   };
    /// }
    /// process.stdout.write(JSON.stringify(routeStyles));
    /// ```
    #[test]
    fn encode_route_styles_matches_node_golden() {
        let routes = vec![
            route("R1", "ff0000", "BUS"),
            route("R2", "00ff00", "TRAM"),
            route("R3", "", "METRO"),
        ];
        let mut route_sub_mode_map = HashMap::new();
        route_sub_mode_map.insert("R1".to_string(), "BUS:1a2b3c".to_string());
        route_sub_mode_map.insert("R3".to_string(), "GHOST".to_string());
        let sub_modes = vec![sub_mode_entry(
            "BUS:1a2b3c",
            "Bus (blue)",
            "BUS",
            Some("blue"),
            "BUS",
            "#1a2b3c",
            1,
            &[],
        )];

        let got = encode_route_styles(&routes, &route_sub_mode_map, &sub_modes);
        let expected =
            include_bytes!("../../tests/fixtures/color_artifacts_golden_route_styles.json");
        assert_eq!(got, expected.to_vec());
    }

    /// Pins JSON escaping for both the object KEY (route id) and a string
    /// VALUE (`subMode`, via the fall-through `r.mode` path).
    ///
    /// Regeneration:
    /// ```js
    /// function contrastTextColor(hex) { /* identical to above */ }
    /// const id = 'r"1\\t';
    /// const mode = "B\tUS";
    /// const normalized = "#abcdef";
    /// const routeStyles = {
    ///   [id]: {
    ///     color: normalized.replace(/^#/, ""),
    ///     textColor: contrastTextColor(normalized) === "#000000" ? "000000" : "FFFFFF",
    ///     subMode: mode,
    ///   },
    /// };
    /// process.stdout.write(JSON.stringify(routeStyles));
    /// ```
    #[test]
    fn encode_route_styles_matches_node_golden_escapes() {
        let routes = vec![route("r\"1\\t", "abcdef", "B\tUS")];
        let route_sub_mode_map = HashMap::new();
        let sub_modes: Vec<SubModeEntry> = vec![];

        let got = encode_route_styles(&routes, &route_sub_mode_map, &sub_modes);
        let expected =
            include_bytes!("../../tests/fixtures/color_artifacts_golden_route_styles_escapes.json");
        assert_eq!(got, expected.to_vec());
    }

    /// Numeric-looking route ids ("42", "7") are canonical JS array-index
    /// keys and must enumerate ahead of non-numeric ids in ascending
    /// numeric order, regardless of insertion order — mirrors
    /// schedule_tiles/wire.rs's `encode_reorders_numeric_stop_ids_like_js_object_keys`.
    /// Checked via raw byte position (not `serde_json::Value`, which this
    /// crate doesn't build with `preserve_order` and would silently hide
    /// the bug by re-sorting alphabetically).
    #[test]
    fn encode_route_styles_reorders_numeric_route_ids_like_js_object_keys() {
        let routes = vec![
            route("B", "111111", "BUS"),
            route("42", "222222", "BUS"),
            route("7", "333333", "BUS"),
        ];
        let route_sub_mode_map = HashMap::new();
        let sub_modes: Vec<SubModeEntry> = vec![];

        let body = encode_route_styles(&routes, &route_sub_mode_map, &sub_modes);
        let text = String::from_utf8(body).unwrap();
        let pos = |needle: &str| text.find(needle).unwrap();
        assert!(
            pos("\"7\":") < pos("\"42\":") && pos("\"42\":") < pos("\"B\":"),
            "numeric route ids must sort ascending ahead of non-numeric ids, \
             regardless of insertion order; got: {text}"
        );
    }

    // --- label-anchors.json -----------------------------------------------

    /// Golden fixture: 3 stop-id -> anchor-direction pairs in
    /// non-alphabetical insertion order, matching `Object.fromEntries` over
    /// an equivalent `Map`.
    ///
    /// Regeneration:
    /// ```js
    /// const anchors = new Map([["stop_z", "top"], ["stop_a", "bottom-left"], ["stop_m", "right"]]);
    /// process.stdout.write(JSON.stringify(Object.fromEntries(anchors)));
    /// ```
    #[test]
    fn encode_label_anchors_matches_node_golden() {
        let mut anchors: IndexMap<String, &'static str> = IndexMap::new();
        anchors.insert("stop_z".to_string(), "top");
        anchors.insert("stop_a".to_string(), "bottom-left");
        anchors.insert("stop_m".to_string(), "right");

        let got = encode_label_anchors(&anchors);
        let expected =
            include_bytes!("../../tests/fixtures/color_artifacts_golden_label_anchors.json");
        assert_eq!(got, expected.to_vec());
    }

    /// Pins JSON escaping for the object KEY (stop id) — values are always
    /// one of the 8 fixed `DIRS` tokens (anchors.rs), so no value-escaping
    /// path exists to pin here.
    ///
    /// Regeneration:
    /// ```js
    /// const anchors = new Map([['s"top\n1', "top"]]);
    /// process.stdout.write(JSON.stringify(Object.fromEntries(anchors)));
    /// ```
    #[test]
    fn encode_label_anchors_matches_node_golden_escapes() {
        let mut anchors: IndexMap<String, &'static str> = IndexMap::new();
        anchors.insert("s\"top\n1".to_string(), "top");

        let got = encode_label_anchors(&anchors);
        let expected = include_bytes!(
            "../../tests/fixtures/color_artifacts_golden_label_anchors_escapes.json"
        );
        assert_eq!(got, expected.to_vec());
    }

    /// Numeric-looking stop ids reorder ahead of non-numeric ones, same
    /// rule as `encode_route_styles_reorders_numeric_route_ids_like_js_object_keys`
    /// — `Object.fromEntries`'s result is still a plain JS object subject
    /// to `OrdinaryOwnPropertyKeys` enumeration.
    #[test]
    fn encode_label_anchors_reorders_numeric_stop_ids_like_js_object_keys() {
        let mut anchors: IndexMap<String, &'static str> = IndexMap::new();
        anchors.insert("B".to_string(), "top");
        anchors.insert("42".to_string(), "left");
        anchors.insert("7".to_string(), "right");

        let body = encode_label_anchors(&anchors);
        let text = String::from_utf8(body).unwrap();
        let pos = |needle: &str| text.find(needle).unwrap();
        assert!(
            pos("\"7\":") < pos("\"42\":") && pos("\"42\":") < pos("\"B\":"),
            "numeric stop ids must sort ascending ahead of non-numeric ids, \
             regardless of insertion order; got: {text}"
        );
    }
}
