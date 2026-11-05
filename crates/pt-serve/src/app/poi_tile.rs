//! `GET /api/gtfs/poi-tile/<cityId>/<tileSize>/<tileCoords>` — brotli-
//! compressed landmark/POI entries for one tile. Parity with
//! `packages/backend/src/routes/poiTile.ts`.
//!
//! ## City-agnostic, `Generation`-independent
//!
//! UNLIKE every other route in this crate: no `&Generation` parameter, no
//! `--city-slug` gate, no `X-PT-Bundle-Hash`. The POI manifest
//! supplies a bounded set of strict corpora entirely independent of whatever
//! GTFS feed this pt-serve process runs. `cityId` is resolved against that
//! manifest, not `ServerConfig::city_slug`.
//!
//! ## Compression divergence from the schedule-tile BUILD pipeline
//!
//! This handler compresses AT REQUEST TIME (Node's route does too — POI
//! tiles are computed on first request, not pre-built like schedule
//! tiles). It sets ONLY `BROTLI_PARAM_QUALITY: 11`, matching
//! `routes/poiTile.ts`'s `brotliCompressSync` call exactly — unlike
//! `pt-producer`'s `BrotliQ11` (schedule-tile BUILD pipeline), it does NOT
//! set `BROTLI_MODE_TEXT`. This is a confirmed Node-side divergence
//! between the two compression call sites, not an oversight here.
//!
//! ## `resolve_city_tiling`'s three-outcome cache
//!
//! Missing manifests/strict records are never entered into the city
//! singleflight, so caller-controlled ids cannot grow its map. A missing or
//! disabled `poiTile` block is cached as inactive. Active records are
//! size/hash checked, decoded, validated, and indexed once per city; typed
//! loader failures become 500 responses. Production startup runs the same
//! validation before binding.

use crate::app::response::{ByteBody, Resp};
use crate::ops::poi_tile_cache::{PoiCityTiling, PoiTileCacheBuildError};
use crate::ops::{log_event, LogLevel, ServerCtx};
use crate::poi::catalog::{
    city_id_valid, read_city_entries_from, validate_tiling, PoiBundleLoadError, PoiPreflightCity,
};
use pt_shared::poi_bundle_wire::PoiEntry;
use serde::Serialize;
use std::sync::Arc;

const CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

fn json_error(status: u16, code: &str, message: impl Into<String>) -> Resp {
    let json_body = serde_json::json!({
        "error": {
            "code": code,
            "message": message.into(),
        }
    })
    .to_string();
    Resp::PoiTile {
        status,
        content_type: "application/json; charset=utf-8",
        cache_control: Some("no-store"),
        body: None,
        json_body: Some(json_body),
        etag: None,
        attribution: false,
    }
}

fn bundle_load_error(ctx: &ServerCtx, city_id: &str, error: &PoiBundleLoadError) -> Resp {
    let detail = error.to_string();
    log_event(
        ctx.config.log_format,
        LogLevel::Error,
        "poi_bundle_load_failed",
        &[
            ("cityId", city_id),
            ("errorKind", error.kind()),
            ("error", &detail),
        ],
    );
    json_error(500, "POI_BUNDLE_LOAD_ERROR", "POI data could not be loaded")
}

#[derive(Serialize)]
struct WirePoiTileResponse<'a> {
    #[serde(rename = "tileKey")]
    tile_key: &'a str,
    entries: Vec<&'a PoiEntry>,
}

/// Parse `^-?\d{1,6}_-?\d{1,6}$` — port of `TILE_COORD_PATTERN`
/// (`routes/poiTile.ts:52`). Deliberately narrower than
/// `pt_shared::tile_coord::parse_tile_coords`: POI tiles have no
/// subdivision/leaf-suffix concept at all, so unlike schedule/rt-tile a
/// dash-suffixed coord is REJECTED here, not passed through for the
/// handler to interpret.
fn parse_tile_coords(s: &str) -> Option<(i64, i64)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'-') {
        i += 1;
    }
    let x_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    if i - x_start == 0 || i - x_start > 6 {
        return None;
    }
    if bytes.get(i) != Some(&b'_') {
        return None;
    }
    i += 1;
    if bytes.get(i) == Some(&b'-') {
        i += 1;
    }
    let y_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    if i - y_start == 0 || i - y_start > 6 {
        return None;
    }
    if i != bytes.len() {
        return None;
    }
    let (x, y) = s.split_once('_')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

/// Quality-11-only brotli (no `BROTLI_MODE_TEXT`) — see the module doc's
/// compression-divergence note.
fn compress_q11(input: &[u8]) -> Result<Vec<u8>, PoiBundleLoadError> {
    let mut out = Vec::new();
    let params = brotli::enc::BrotliEncoderParams {
        quality: 11,
        ..Default::default()
    };
    brotli::BrotliCompress(&mut &input[..], &mut out, &params)
        .map_err(PoiBundleLoadError::Compress)?;
    Ok(out)
}

/// Resolve `city_id` against the POI release currently behind
/// `poi_bundle_dir`. The manifest cache is consulted first so a promoted
/// release reaches cities that already served tiles; the per-city resolution
/// is reused only while it came from that same release.
fn resolve_city_tiling(
    ctx: &ServerCtx,
    city_id: &str,
) -> Result<Option<PoiCityTiling>, Arc<PoiBundleLoadError>> {
    let Some(preflight) = ctx
        .poi_manifest_cache
        .get_or_load(&ctx.config)
        .map_err(Arc::new)?
    else {
        return Ok(None);
    };
    let Some(city) = preflight.cities.iter().find(|city| match city {
        PoiPreflightCity::Inactive { city_id: candidate }
        | PoiPreflightCity::Active {
            city_id: candidate, ..
        } => candidate == city_id,
    }) else {
        return Ok(None);
    };

    ctx.poi_city_tiling_cache
        .get_or_try_resolve(city_id, &preflight.pinned_dir, || {
            Ok(match city {
                PoiPreflightCity::Inactive { .. } => PoiCityTiling::Inactive,
                PoiPreflightCity::Active {
                    contract,
                    bundle_sha256,
                    ..
                } => {
                    let record = preflight
                        .manifest
                        .strict_bundle(city_id)
                        .map_err(PoiBundleLoadError::Config)?
                        .ok_or_else(|| {
                            PoiBundleLoadError::Config(format!(
                                "active strict record for {city_id} disappeared from pinned manifest"
                            ))
                        })?;
                    let entries = Arc::new(read_city_entries_from(
                        &ctx.config,
                        &preflight.pinned_dir,
                        record,
                    )?);
                    let index = Arc::new(validate_tiling(city_id, contract, &entries)?);
                    PoiCityTiling::Active {
                        edge_km: contract.tiling.edge_km,
                        index,
                        entries,
                        tile_bounds: contract.tile_bounds,
                        bundle_sha256: Arc::clone(bundle_sha256),
                    }
                }
            })
        })
        .map(Some)
}

pub fn poi_tile(
    ctx: &ServerCtx,
    city_id: &str,
    tile_size: &str,
    tile_coords: &str,
    if_none_match: Option<&str>,
) -> Resp {
    poi_tile_with_version(ctx, city_id, tile_size, tile_coords, None, if_none_match)
}

pub fn poi_tile_with_version(
    ctx: &ServerCtx,
    city_id: &str,
    tile_size: &str,
    tile_coords: &str,
    requested_bundle_sha256: Option<&str>,
    if_none_match: Option<&str>,
) -> Resp {
    if !city_id_valid(city_id) {
        return json_error(400, "INVALID_CITY_ID", "Invalid cityId");
    }

    let (edge_km, index, entries, tile_bounds, bundle_sha256) =
        match resolve_city_tiling(ctx, city_id) {
            Err(error) => return bundle_load_error(ctx, city_id, &error),
            Ok(None) => {
                return json_error(
                    404,
                    "UNKNOWN_CITY",
                    format!("No POI data for city: {city_id}"),
                );
            }
            Ok(Some(PoiCityTiling::Inactive)) => {
                return json_error(
                    503,
                    "POI_TILE_DELIVERY_INACTIVE",
                    format!("Per-tile POI delivery is not active for city: {city_id}"),
                );
            }
            Ok(Some(PoiCityTiling::Active {
                edge_km,
                index,
                entries,
                tile_bounds,
                bundle_sha256,
            })) => (edge_km, index, entries, tile_bounds, bundle_sha256),
        };

    if requested_bundle_sha256.is_some_and(|requested| requested != bundle_sha256.as_ref()) {
        return json_error(
            409,
            "POI_CORPUS_VERSION_MISMATCH",
            format!("POI corpus version changed for city: {city_id}"),
        );
    }

    let expected_label = format!("{edge_km}km");
    if tile_size != expected_label {
        return json_error(
            400,
            "TILE_SIZE_MISMATCH",
            format!("Server uses {expected_label} tiles for {city_id}; got {tile_size}"),
        );
    }

    let Some((tile_x, tile_y)) = parse_tile_coords(tile_coords) else {
        return json_error(
            400,
            "INVALID_TILE_KEY",
            format!("Malformed tile coords: {tile_coords}"),
        );
    };
    if tile_coords != format!("{tile_x}_{tile_y}") {
        return json_error(
            400,
            "INVALID_TILE_KEY",
            format!("Malformed tile coords: {tile_coords}"),
        );
    }

    if !tile_bounds.contains(tile_x, tile_y) {
        return json_error(
            404,
            "UNKNOWN_TILE",
            format!("Tile coords outside city grid: {tile_coords}"),
        );
    }

    let tile_key = format!("{city_id}/{tile_size}/{tile_coords}");
    let cache_key = format!("{bundle_sha256}:{tile_key}");

    let cached = match ctx
        .poi_tile_response_cache
        .get_or_try_insert_with(cache_key, || {
            let indices = index.entry_indices(tile_coords);
            let mut tile_entries = Vec::with_capacity(indices.len());
            for &entry_ix in indices {
                let entry = entries.get(entry_ix).ok_or_else(|| {
                    PoiBundleLoadError::Config(format!(
                        "POI index for {city_id} references missing entry {entry_ix}"
                    ))
                })?;
                tile_entries.push(entry);
            }
            let body = WirePoiTileResponse {
                tile_key: &tile_key,
                entries: tile_entries,
            };
            let json = serde_json::to_string(&body).map_err(PoiBundleLoadError::Json)?;

            let etag = {
                use sha2::{Digest, Sha256};
                let full_hex = format!("{:x}", Sha256::digest(json.as_bytes()));
                format!("\"{}\"", &full_hex[..16])
            };
            let compressed: Arc<[u8]> =
                Arc::from(compress_q11(json.as_bytes())?.into_boxed_slice());
            let cached = crate::ops::CachedPoiTileResponse { etag, compressed };
            Ok(cached)
        }) {
        Ok(cached) => cached,
        Err(PoiTileCacheBuildError::Busy) => {
            // Counted HERE, where the typed `Busy` variant is in hand. The
            // dispatcher sees only a `Resp` and a status string, and both POI
            // 503s (this one and POI_TILE_DELIVERY_INACTIVE) look identical
            // there — recovering the distinction downstream would mean
            // string-searching the serialized error body, which would break
            // silently the moment the error envelope changes.
            //
            // This is a SUBSET of the 503s: the dispatcher still records this
            // request in `poi_tile_requests_total{status="503"}` as before.
            ctx.metrics
                .inc_poi_tile_shed(&crate::http::server::classified_poi_city(ctx, city_id));
            return json_error(
                503,
                "POI_TILE_BUILD_BUSY",
                "POI tile build capacity is busy; retry shortly",
            );
        }
        Err(PoiTileCacheBuildError::Load(error)) => {
            return bundle_load_error(ctx, city_id, &error);
        }
    };

    if if_none_match == Some(cached.etag.as_str()) {
        return Resp::PoiTile {
            status: 304,
            content_type: "application/json",
            cache_control: Some(CACHE_CONTROL),
            body: None,
            json_body: None,
            etag: Some(cached.etag),
            attribution: true,
        };
    }

    Resp::PoiTile {
        status: 200,
        content_type: "application/json",
        cache_control: Some(CACHE_CONTROL),
        body: Some(ByteBody::Raw(cached.compressed)),
        json_body: None,
        etag: Some(cached.etag),
        attribution: true,
    }
}
