//! `GET /api/<city>/address-search*` — optional PTN-native address geocoder.
//!
//! The address corpus is a generation-scoped sidecar (`address-search.json`).
//! When absent, all three routes 404. When present, startup has already parsed
//! and validated it and built the in-memory FST, so request handling is a
//! bounded prefix scan plus JSON serialization.

use crate::app::query::decode_form_component;
use crate::app::response::{if_none_match_hits, ByteBody, Resp};
use crate::bundle::Generation;
use serde_json::json;
use std::sync::Arc;

const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 20;
const MAX_QUERY_PARAM_NAME_BYTES: usize = 32;
const MAX_QUERY_BYTES: usize = 256;
const MAX_LIMIT_BYTES: usize = 8;
const MAX_COORD_BYTES: usize = 32;
const EARTH_RADIUS_M: f64 = 6_371_000.0;
const PROXIMITY_BONUS_RADIUS_M: f64 = 50_000.0;
const JSON: &str = "application/json";
const REVALIDATE: &str = "public, max-age=0, must-revalidate";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueryError {
    Malformed,
}

pub fn manifest(gen: &Generation, if_none_match: Option<&str>) -> Resp {
    let Some(sidecar) = gen.address_search.as_ref() else {
        return Resp::NotFoundEmpty;
    };
    if if_none_match_hits(if_none_match, &sidecar.etag) {
        return Resp::NotModified {
            etag: sidecar.etag.clone(),
            provenance: None,
        };
    }
    Resp::CachedBytes {
        status: 200,
        body: ByteBody::Raw(Arc::clone(&sidecar.manifest_body)),
        content_type: JSON,
        cache_control: REVALIDATE,
        etag: Some(sidecar.etag.clone()),
        gzipped: false,
    }
}

/// `GET /api/<city>/address-search/bundle` — the whole corpus.
///
/// This is the one route whose body a client is expected to download in full:
/// the PWA fetches it once, SHA-verifies it against the manifest and keeps it
/// in IndexedDB so address search works offline. It is also by far the largest
/// body this process serves (21.4 MB on vilnius), so it is served gzipped
/// whenever the client accepts it — 3.2 MB on that same corpus.
///
/// The ETag is the SHA of the RAW bytes in both branches, deliberately.
/// `Content-Encoding` is a transfer property, not an identity: the manifest
/// advertises `sha256` and `sizeBytes` of the decoded artifact, and
/// `addressSearchLoader` checks both after the browser has decompressed.
/// Varying the ETag by encoding would make a client that switched encodings
/// re-download bytes it already has.
pub fn bundle(gen: &Generation, if_none_match: Option<&str>, accept_gzip: bool) -> Resp {
    let Some(sidecar) = gen.address_search.as_ref() else {
        return Resp::NotFoundEmpty;
    };
    if if_none_match_hits(if_none_match, &sidecar.etag) {
        return Resp::NotModified {
            etag: sidecar.etag.clone(),
            provenance: None,
        };
    }
    let (body, gzipped) = if accept_gzip {
        let gz = sidecar
            .artifact_gzip
            .get_or_init(|| Arc::from(crate::bundle::generation::gzip(&sidecar.artifact_body)));
        (ByteBody::Gzip(Arc::clone(gz)), true)
    } else {
        (ByteBody::Raw(Arc::clone(&sidecar.artifact_body)), false)
    };
    Resp::CachedBytes {
        status: 200,
        body,
        content_type: JSON,
        cache_control: REVALIDATE,
        etag: Some(sidecar.etag.clone()),
        gzipped,
    }
}

pub fn search(query: &str, gen: &Generation) -> Resp {
    let Some(sidecar) = gen.address_search.as_ref() else {
        return Resp::NotFoundEmpty;
    };

    let q = match query_param(query, "q", MAX_QUERY_BYTES) {
        Ok(Some(q)) if !q.trim().is_empty() => q,
        Ok(_) => return ok_search(Vec::new(), Vec::new()),
        Err(QueryError::Malformed) => return bad_request("BAD_QUERY", "Malformed q parameter"),
    };
    let limit = match limit_param(query) {
        Ok(limit) => limit,
        Err(QueryError::Malformed) => return bad_request("BAD_LIMIT", "Malformed limit parameter"),
    };
    // Optional client-supplied proximity hint (`SelfHostedGeocoderAdapter.ts`'s
    // ptn-fst flavor always sends it). Best-effort: missing, non-numeric, or
    // out-of-range lat/lon degrades to no hint rather than a 400 — this only
    // ever nudges result ORDERING, it never changes which rows match.
    let hint = latlon_hint(query);

    let variants = pt_geocode::address_search_query_variants(&q);
    if variants.is_empty() {
        return ok_search(Vec::new(), variants);
    }

    let matches = sidecar
        .index
        .prefix_search_any(variants.iter().map(String::as_str), limit);
    let data = matches
        .into_iter()
        .map(|m| {
            json!({
                "label": m.label,
                "lat": m.lat,
                "lon": m.lon,
                "confidence": confidence_for_key(&m.key, &variants, m.lat, m.lon, hint),
                "matchedKey": m.key,
            })
        })
        .collect();
    ok_search(data, variants)
}

fn ok_search(data: Vec<serde_json::Value>, variants: Vec<String>) -> Resp {
    Resp::Json {
        status: 200,
        body: json!({
            "data": data,
            "meta": {
                "provider": "ptn-fst",
                "queryVariants": variants,
            },
        })
        .to_string(),
    }
}

fn bad_request(code: &str, message: &str) -> Resp {
    Resp::Json {
        status: 400,
        body: json!({
            "error": {
                "code": code,
                "message": message,
            },
        })
        .to_string(),
    }
}

/// Base confidence mirrors the TS `AddressSearchGeocoderAdapter`'s
/// exact-vs-prefix split; the proximity bonus (when `hint` resolves) mirrors
/// its `scoreMatch`: up to +0.08 within `PROXIMITY_BONUS_RADIUS_M`, clamped so
/// it can never push an already-1.0 exact match above 1.0.
fn confidence_for_key(
    key: &str,
    variants: &[String],
    row_lat: f64,
    row_lon: f64,
    hint: Option<(f64, f64)>,
) -> f64 {
    let base = if variants.iter().any(|variant| variant == key) {
        1.0
    } else {
        0.9
    };
    let Some((hint_lat, hint_lon)) = hint else {
        return base;
    };
    let dist = haversine_meters(hint_lat, hint_lon, row_lat, row_lon);
    let bonus = (0.08 * (1.0 - dist / PROXIMITY_BONUS_RADIUS_M)).max(0.0);
    (base + bonus).min(1.0)
}

fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let d_lat = (lat2 - lat1) * to_rad;
    let d_lon = (lon2 - lon1) * to_rad;
    let a = (d_lat / 2.0).sin().powi(2)
        + (lat1 * to_rad).cos() * (lat2 * to_rad).cos() * (d_lon / 2.0).sin().powi(2);
    EARTH_RADIUS_M * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// Parses `lat`/`lon` query params into a proximity hint. Returns `None` on
/// anything short of two finite, in-range coordinates — malformed encoding,
/// missing param, non-numeric value, or out-of-range value all degrade to "no
/// hint" rather than an error, since this is a ranking nicety, not a required
/// parameter.
fn latlon_hint(query: &str) -> Option<(f64, f64)> {
    let lat_raw = query_param(query, "lat", MAX_COORD_BYTES).ok().flatten()?;
    let lon_raw = query_param(query, "lon", MAX_COORD_BYTES).ok().flatten()?;
    let lat: f64 = lat_raw.trim().parse().ok()?;
    let lon: f64 = lon_raw.trim().parse().ok()?;
    if !lat.is_finite() || !lon.is_finite() {
        return None;
    }
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return None;
    }
    Some((lat, lon))
}

fn limit_param(query: &str) -> Result<usize, QueryError> {
    let Some(raw) = query_param(query, "limit", MAX_LIMIT_BYTES)? else {
        return Ok(DEFAULT_LIMIT);
    };
    if raw.trim().is_empty() {
        return Ok(DEFAULT_LIMIT);
    }
    let parsed = raw
        .parse::<usize>()
        .map_err(|_| QueryError::Malformed)?
        .clamp(1, MAX_LIMIT);
    Ok(parsed)
}

fn query_param(
    query: &str,
    key: &str,
    max_decoded_bytes: usize,
) -> Result<Option<String>, QueryError> {
    let mut found = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_name, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let Ok(name) = decode_form_component(raw_name, MAX_QUERY_PARAM_NAME_BYTES) else {
            continue;
        };
        if name != key {
            continue;
        }
        if found.is_some() {
            return Err(QueryError::Malformed);
        }
        found = Some(
            decode_form_component(raw_value, max_decoded_bytes)
                .map_err(|_| QueryError::Malformed)?,
        );
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_param_form_decodes_utf8_and_plus() {
        assert_eq!(
            query_param("q=Kudirkos+aik%C5%A1t%C4%97", "q", MAX_QUERY_BYTES).unwrap(),
            Some("Kudirkos aikštė".to_string())
        );
    }

    #[test]
    fn malformed_percent_encoding_rejects_query() {
        assert_eq!(
            query_param("q=%C5", "q", MAX_QUERY_BYTES),
            Err(QueryError::Malformed)
        );
    }

    #[test]
    fn limit_defaults_and_clamps() {
        assert_eq!(limit_param("").unwrap(), DEFAULT_LIMIT);
        assert_eq!(limit_param("limit=0").unwrap(), 1);
        assert_eq!(limit_param("limit=999").unwrap(), MAX_LIMIT);
    }

    #[test]
    fn unrelated_params_do_not_poison_query_lookup() {
        assert_eq!(
            query_param("limit=3&q=Kudirkos", "q", MAX_QUERY_BYTES).unwrap(),
            Some("Kudirkos".to_string())
        );
    }

    #[test]
    fn latlon_hint_parses_valid_coords() {
        assert_eq!(
            latlon_hint("q=x&lat=54.6872&lon=25.2797"),
            Some((54.6872, 25.2797))
        );
    }

    #[test]
    fn latlon_hint_degrades_on_missing_or_invalid() {
        assert_eq!(latlon_hint("q=x"), None);
        assert_eq!(latlon_hint("q=x&lat=not-a-number&lon=25.2797"), None);
        assert_eq!(latlon_hint("q=x&lat=999&lon=25.2797"), None);
    }

    #[test]
    fn confidence_gets_proximity_bonus_within_radius() {
        let variants = vec!["kudirkos".to_string()];
        let far = confidence_for_key("kudirkos", &variants, 0.0, 0.0, None);
        let near = confidence_for_key(
            "kudirkos",
            &variants,
            54.6872,
            25.2797,
            Some((54.6872, 25.2797)),
        );
        assert_eq!(far, 1.0);
        assert_eq!(near, 1.0); // already-exact match clamps at 1.0
        let partial_far = confidence_for_key("other", &variants, 0.0, 0.0, None);
        let partial_near = confidence_for_key(
            "other",
            &variants,
            54.6872,
            25.2797,
            Some((54.6872, 25.2797)),
        );
        assert!(partial_near > partial_far);
    }
}
