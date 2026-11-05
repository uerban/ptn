//! osmium `export -f geojsonseq` reader: one feature per line, optionally
//! prefixed with the RS (0x1E) record separator.

use serde_json::Value;

use crate::format::WayClass;

/// Highway values the extract keeps. `scripts/build-walk-graphs.mjs` passes
/// exactly this list to `osmium tags-filter`; its test pins the two together.
pub const WALK_HIGHWAYS: &[&str] = &[
    "footway",
    "path",
    "pedestrian",
    "steps",
    "track",
    "sidewalk",
    "crossing",
    "living_street",
    "residential",
    "unclassified",
    "service",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
    "cycleway",
    "bridleway",
];

const PATH_HIGHWAYS: &[&str] = &[
    "footway",
    "path",
    "pedestrian",
    "track",
    "living_street",
    "sidewalk",
];
const STREET_HIGHWAYS: &[&str] = &[
    "residential",
    "unclassified",
    "service",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Way {
    /// One or more lines of `(lon, lat)`.
    pub parts: Vec<Vec<(f64, f64)>>,
    pub name: String,
    pub class: WayClass,
}

/// Walkable class of a way, or `None` when pedestrians may not use it.
pub fn classify(
    highway: &str,
    footway: Option<&str>,
    access: Option<&str>,
    foot: Option<&str>,
) -> Option<WayClass> {
    let mut foot_kept = false;
    match foot {
        Some("no" | "private" | "use_sidepath") => return None,
        Some("yes" | "designated" | "permissive" | "destination" | "official") => foot_kept = true,
        _ => {
            if matches!(access, Some("no" | "private")) {
                return None;
            }
        }
    }
    if highway == "steps" {
        return Some(WayClass::Steps);
    }
    if matches!(highway, "cycleway" | "bridleway") {
        return foot_kept.then_some(WayClass::Path);
    }
    let is_path = PATH_HIGHWAYS.contains(&highway);
    if highway == "crossing" || (is_path && footway == Some("crossing")) {
        return Some(WayClass::Crossing);
    }
    if is_path {
        return Some(WayClass::Path);
    }
    if STREET_HIGHWAYS.contains(&highway) {
        return Some(WayClass::Street);
    }
    None
}

fn line_coords(v: &Value) -> Result<Vec<(f64, f64)>, String> {
    v.as_array()
        .ok_or("coordinates are not an array")?
        .iter()
        .map(|p| {
            let a = p.as_array().ok_or("position is not an array")?;
            let lon = a
                .first()
                .and_then(Value::as_f64)
                .ok_or("position has no longitude")?;
            let lat = a
                .get(1)
                .and_then(Value::as_f64)
                .ok_or("position has no latitude")?;
            if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
                return Err(format!("position out of range: [{lon}, {lat}]"));
            }
            Ok((lon, lat))
        })
        .collect()
}

/// Parse one GeoJSONSeq line. `Ok(None)` for blank lines, non-line
/// geometries, and ways pedestrians cannot use.
pub fn parse_feature(line: &str) -> Result<Option<Way>, String> {
    let t = line.trim_start_matches('\u{1e}').trim();
    if t.is_empty() {
        return Ok(None);
    }
    let v: Value = serde_json::from_str(t).map_err(|e| e.to_string())?;
    let props = &v["properties"];
    let s = |k: &str| props.get(k).and_then(Value::as_str);
    let Some(highway) = s("highway") else {
        return Ok(None);
    };
    let Some(class) = classify(highway, s("footway"), s("access"), s("foot")) else {
        return Ok(None);
    };
    let geom = &v["geometry"];
    let parts = match geom["type"].as_str() {
        Some("LineString") => vec![line_coords(&geom["coordinates"])?],
        Some("MultiLineString") => geom["coordinates"]
            .as_array()
            .ok_or("MultiLineString coordinates are not an array")?
            .iter()
            .map(line_coords)
            .collect::<Result<_, _>>()?,
        _ => return Ok(None),
    };
    Ok(Some(Way {
        parts,
        name: s("name").unwrap_or("").to_owned(),
        class,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(props: &str) -> String {
        format!(
            r#"{{"type":"Feature","geometry":{{"type":"LineString","coordinates":[[25.28,54.68],[25.281,54.68]]}},"properties":{props}}}"#
        )
    }

    #[test]
    fn classifies_highways() {
        assert_eq!(classify("steps", None, None, None), Some(WayClass::Steps));
        assert_eq!(
            classify("crossing", None, None, None),
            Some(WayClass::Crossing)
        );
        assert_eq!(
            classify("footway", Some("crossing"), None, None),
            Some(WayClass::Crossing)
        );
        assert_eq!(
            classify("footway", Some("sidewalk"), None, None),
            Some(WayClass::Path)
        );
        assert_eq!(
            classify("residential", Some("crossing"), None, None),
            Some(WayClass::Street)
        );
        assert_eq!(
            classify("primary", None, None, None),
            Some(WayClass::Street)
        );
        assert_eq!(classify("motorway", None, None, None), None);
    }

    #[test]
    fn foot_overrides_access() {
        assert_eq!(classify("service", None, Some("private"), None), None);
        assert_eq!(
            classify("path", None, Some("private"), Some("yes")),
            Some(WayClass::Path)
        );
        assert_eq!(classify("footway", None, None, Some("no")), None);
        assert_eq!(
            classify("footway", None, Some("yes"), Some("use_sidepath")),
            None
        );
        assert_eq!(
            classify("residential", None, Some("destination"), None),
            Some(WayClass::Street)
        );
    }

    #[test]
    fn shared_foot_cycle_paths_need_explicit_foot() {
        assert_eq!(classify("cycleway", None, None, None), None);
        assert_eq!(
            classify("cycleway", None, None, Some("designated")),
            Some(WayClass::Path)
        );
        assert_eq!(
            classify("bridleway", None, None, Some("yes")),
            Some(WayClass::Path)
        );
        assert_eq!(classify("bridleway", None, None, Some("no")), None);
    }

    #[test]
    fn foot_destination_and_official_override_private_access() {
        assert_eq!(
            classify("service", None, Some("private"), Some("destination")),
            Some(WayClass::Street)
        );
        assert_eq!(
            classify("path", None, Some("no"), Some("official")),
            Some(WayClass::Path)
        );
    }

    #[test]
    fn parses_line_and_multiline_features() {
        let w = parse_feature(&line(r#"{"highway":"residential","name":"Pylimo g."}"#))
            .unwrap()
            .unwrap();
        assert_eq!(w.name, "Pylimo g.");
        assert_eq!(w.class, WayClass::Street);
        assert_eq!(w.parts, vec![vec![(25.28, 54.68), (25.281, 54.68)]]);

        let multi = r#"{"type":"Feature","geometry":{"type":"MultiLineString","coordinates":[[[1,2],[3,4]],[[5,6],[7,8]]]},"properties":{"highway":"path"}}"#;
        let w = parse_feature(multi).unwrap().unwrap();
        assert_eq!(w.parts.len(), 2);
        assert_eq!(w.name, "");
    }

    #[test]
    fn skips_blank_lines_points_and_unwalkable_ways() {
        assert_eq!(parse_feature("").unwrap(), None);
        assert_eq!(parse_feature("\u{1e}   ").unwrap(), None);
        let point = r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[25.28,54.68]},"properties":{"highway":"crossing"}}"#;
        assert_eq!(parse_feature(point).unwrap(), None);
        assert_eq!(
            parse_feature(&line(r#"{"highway":"motorway"}"#)).unwrap(),
            None
        );
        assert_eq!(parse_feature(&line(r#"{"building":"yes"}"#)).unwrap(), None);
    }

    #[test]
    fn strips_record_separator() {
        let rs = format!("\u{1e}{}", line(r#"{"highway":"steps"}"#));
        assert_eq!(parse_feature(&rs).unwrap().unwrap().class, WayClass::Steps);
    }

    #[test]
    fn rejects_malformed_json_and_coordinates() {
        assert!(parse_feature("{not json").is_err());
        let bad = r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[200,54]]},"properties":{"highway":"path"}}"#;
        assert!(parse_feature(bad).is_err());
    }
}
