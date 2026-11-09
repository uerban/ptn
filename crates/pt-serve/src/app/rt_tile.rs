//! `GET /api/<city>/gtfs/rt-tile/<bundleHash>/<tileSize>/<tileCoords>` — the
//! RT overlay route: decodes the schedule tile server-side to learn trip
//! membership, then attaches live GTFS-RT delay/cancellation data per trip.
//! Parity with `packages/backend/src/routes/rtTile.ts`.
//!
//! ## Ordering divergence from `app::schedule_tile` (documented in the plan)
//!
//! The subdivision gate runs BEFORE any cache lookup (matches Node); the
//! `tiles_dir.is_dir()` unavailability check runs AFTER the response- and
//! membership-cache lookups, on a membership-cache MISS only — the opposite
//! order from `schedule_tile`'s early gate. A subdivided-cell 404 or a
//! cache hit therefore never touches the filesystem at all, matching Node
//! exactly.
//!
//! ## Response body shape
//!
//! No `leaves` field on the `tile_subdivided` 404 (unlike schedule-tile) —
//! confirmed against the Node route directly. No `receivedAt` field on the
//! 200 body — Node explicitly excludes it.
//!
//! ## Missing tile file is 409, not 503
//!
//! An absent tile file with the tiles dir present is `409 bundle_unavailable`,
//! matching Node's `existsSync(tilePath)` gate. This module previously funnelled
//! it into the `503 TILE_READ_ERROR` arm along with genuine read and decode
//! failures, because the read was written as `fs::read(..).ok()` — which
//! discards `ErrorKind` and so cannot tell "not built yet" from "unreadable".
//! Nothing user-visible depended on it (`fetchRtTile` in
//! `packages/frontend/src/services/api.ts` maps every non-200 to the same
//! rt-unavailable state), but the two planes reported different statuses for
//! the same condition, and 503 misattributes an in-flight build to a broken
//! server in `requests_total{route="rt-tile"}`.
//!
//! Note this is NOT the sibling route's answer: `app::schedule_tile` returns
//! `404 tile_not_found` for the same `ErrorKind::NotFound`, correctly, because
//! it serves the tile itself — an absent file is terminal there and retryable
//! here.

use crate::app::response::Resp;
use crate::bundle::Generation;
use crate::ops::ServerCtx;
use pt_shared::clock::Clock;
use pt_shared::schedule_tile_wire::ScheduleTileTripMembership;
use pt_shared::tile_coord::{parse_tile_coords, SCHEDULE_TILE_SIZE_LABEL};
use serde::Serialize;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

fn json_error(status: u16, bundle_hash: Option<String>, json_body: String) -> Resp {
    Resp::WithBundleHash {
        status,
        content_type: "application/json",
        cache_control: None,
        body: None,
        json_body: Some(json_body),
        etag: None,
        bundle_hash,
        vary_accept_encoding: false,
    }
}

#[derive(Serialize)]
struct WireTripUpdate<'a> {
    #[serde(rename = "tripId")]
    trip_id: &'a str,
    #[serde(rename = "delaySeconds")]
    delay_seconds: i32,
    cancelled: bool,
    /// DELETED: the client drops the trip from its boards. Only when true —
    /// absent reads as "not deleted" (`RtTripUpdate.deleted` is optional).
    #[serde(skip_serializing_if = "is_false")]
    deleted: bool,
    #[serde(rename = "startDate", skip_serializing_if = "Option::is_none")]
    start_date: Option<&'a str>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize)]
struct WireRtTileResponse<'a> {
    #[serde(rename = "bundleHash")]
    bundle_hash: &'a str,
    #[serde(rename = "generatedAt")]
    generated_at: u64,
    trips: Vec<WireTripUpdate<'a>>,
}

fn now_ms(clock: &dyn Clock) -> u64 {
    clock
        .now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn rt_tile(
    ctx: &ServerCtx,
    gen: &Generation,
    clock: &dyn Clock,
    bundle_hash: &str,
    tile_size: &str,
    tile_coords: &str,
) -> Resp {
    // ---- 400s: no hash is known to the client yet, so no X-PT-Bundle-Hash. ----
    let hash_valid = bundle_hash.len() == 64
        && bundle_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    if !hash_valid {
        return json_error(
            400,
            None,
            r#"{"error":{"code":"INVALID_BUNDLE_HASH","message":"bundleHash must be 64 hex chars"}}"#
                .to_string(),
        );
    }
    if tile_size != SCHEDULE_TILE_SIZE_LABEL {
        return json_error(
            400,
            None,
            format!(
                r#"{{"error":{{"code":"TILE_SIZE_MISMATCH","message":"Server uses {SCHEDULE_TILE_SIZE_LABEL}"}}}}"#
            ),
        );
    }
    let Some(parsed) = parse_tile_coords(tile_coords) else {
        return json_error(
            400,
            None,
            r#"{"error":{"code":"INVALID_TILE_COORDS","message":"tileCoords must be `<x>_<y>` or a leaf"}}"#
                .to_string(),
        );
    };

    // ---- 409 bundle_hash_mismatch: same one-generation-at-a-time collapse
    // `schedule_tile` uses (see that module's doc). ----
    if bundle_hash != gen.generation_id {
        return json_error(
            409,
            Some(gen.generation_id.clone()),
            format!(
                r#"{{"error":"bundle_hash_mismatch","currentBundleHash":"{}"}}"#,
                gen.generation_id
            ),
        );
    }

    // ---- 404 subdivision gate — BEFORE any cache lookup (parity with
    // Node; the opposite ordering from `schedule_tile`'s dir-existence-first
    // gate). No manifest at all yields no plan, falling through exactly
    // like Node's `getManifestSnapshot?.() ?? null`. No `leaves` array on
    // the subdivided body (unlike `schedule_tile`) — verified against Node
    // directly. ----
    let plan = gen
        .schedule_tile_manifest
        .as_ref()
        .and_then(|m| m.subdivisions.as_ref())
        .and_then(|s| s.get(&parsed.cell_key));
    if parsed.suffix.is_empty() {
        if plan.is_some() {
            return json_error(
                404,
                Some(gen.generation_id.clone()),
                r#"{"error":"tile_subdivided"}"#.to_string(),
            );
        }
    } else {
        let known = plan
            .map(|p| p.leaves.iter().any(|l| l.suffix == parsed.suffix))
            .unwrap_or(false);
        if !known {
            return json_error(
                404,
                Some(gen.generation_id.clone()),
                r#"{"error":"tile_not_found"}"#.to_string(),
            );
        }
    }

    // ---- response-cache lookup — self-scoping key embeds the bundle hash,
    // so no epoch-gating is needed (see `RtTileResponseCache`'s module doc). ----
    let response_cache_key = format!("{}/{bundle_hash}/{tile_coords}", gen.city_slug);
    if let Some(cached_body) = ctx.rt_tile_response_cache.get(clock, &response_cache_key) {
        ctx.metrics.inc_rt_tile_cache("response", "hit");
        return Resp::WithBundleHash {
            status: 200,
            content_type: "application/json",
            cache_control: Some(super::route_rt::RT_CACHE_CONTROL),
            body: None,
            json_body: Some(cached_body),
            etag: None,
            bundle_hash: Some(bundle_hash.to_string()),
            vary_accept_encoding: true,
        };
    }

    ctx.metrics.inc_rt_tile_cache("response", "miss");

    // ---- membership-cache lookup — epoch-gated like `TileCache`; trip
    // membership is immutable per (bundleHash, tileCoords), so no TTL here. ----
    let membership_cache_key = format!("{tile_size}/{tile_coords}");
    let trip_ids: Arc<[String]> = match ctx
        .rt_tile_membership_cache
        .get(gen.epoch, &membership_cache_key)
    {
        Some(cached) => {
            ctx.metrics.inc_rt_tile_cache("membership", "hit");
            cached
        }
        None => {
            ctx.metrics.inc_rt_tile_cache("membership", "miss");
            // ---- 409 bundle_unavailable — deferred until a membership-cache
            // miss (unlike `schedule_tile`'s early gate). ----
            let Some(tiles_dir) = &gen.schedule_tiles_dir else {
                return json_error(
                    409,
                    Some(gen.generation_id.clone()),
                    r#"{"error":"bundle_unavailable"}"#.to_string(),
                );
            };
            if !tiles_dir.is_dir() {
                return json_error(
                    409,
                    Some(gen.generation_id.clone()),
                    r#"{"error":"bundle_unavailable"}"#.to_string(),
                );
            }

            // ---- 409 bundle_unavailable — the tile file itself is absent
            // while the dir exists. Node gates this separately
            // (`existsSync(tilePath)`, routes/rtTile.ts) and its comment gives
            // the case: the hash matches current but the build has not written
            // this tile yet. It is NOT a read error, and it is NOT the
            // schedule-tile route's `tile_not_found` either — that route serves
            // the tile itself, so an absent file is terminal for it, whereas
            // here the client must back off and retry the same coord.
            //
            // Kept distinct from the 503 below rather than collapsed into it:
            // both are non-200 and `fetchRtTile` treats every non-200 alike, so
            // nothing user-visible turns on it today, but a 503 says "this
            // server is broken" to an operator reading
            // `requests_total{route="rt-tile"}` when the truth is an in-flight
            // build. ----
            let tile_path = tiles_dir.join(tile_size).join(format!("{tile_coords}.br"));
            let compressed = match std::fs::read(&tile_path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return json_error(
                        409,
                        Some(gen.generation_id.clone()),
                        r#"{"error":"bundle_unavailable"}"#.to_string(),
                    );
                }
                Err(_) => {
                    return json_error(
                        503,
                        Some(gen.generation_id.clone()),
                        r#"{"error":{"code":"TILE_READ_ERROR","message":"Tile temporarily unavailable"}}"#
                            .to_string(),
                    );
                }
            };

            // ---- brotli-decompress + JSON-decode; either failure is a 503,
            // matching `schedule_tile`'s TILE_READ_ERROR shape. ----
            let mut out = Vec::new();
            let decoded = match brotli::BrotliDecompress(&mut &compressed[..], &mut out) {
                Ok(()) => serde_json::from_slice::<ScheduleTileTripMembership>(&out).ok(),
                Err(_) => None,
            };
            let Some(decoded) = decoded else {
                return json_error(
                    503,
                    Some(gen.generation_id.clone()),
                    r#"{"error":{"code":"TILE_READ_ERROR","message":"Tile temporarily unavailable"}}"#
                        .to_string(),
                );
            };
            let ids: Arc<[String]> = decoded.trip_ids().into();
            ctx.rt_tile_membership_cache
                .set(gen.epoch, membership_cache_key, Arc::clone(&ids));
            ids
        }
    };

    // ---- overlay live RT data per trip — every matching key (bare + every
    // dated variant) surfaces as an independent entry, no merge/precedence
    // between them (the overnight-trip fidelity case). ----
    let rt = ctx.rt.load();
    let mut trips: Vec<WireTripUpdate> = Vec::new();
    for trip_id in trip_ids.iter() {
        let Some(keys) = rt.by_trip.get(trip_id) else {
            continue;
        };
        for key in keys {
            let Some(update) = rt.merged.get(key) else {
                continue;
            };
            let start_date = key.split_once('|').map(|(_, sd)| sd);
            trips.push(WireTripUpdate {
                trip_id,
                delay_seconds: update.delay_seconds,
                cancelled: update.cancelled,
                deleted: update.deleted,
                start_date,
            });
        }
    }

    let body = WireRtTileResponse {
        bundle_hash,
        generated_at: now_ms(clock),
        trips,
    };
    let json_body =
        serde_json::to_string(&body).expect("rt-tile response serialization is infallible");
    ctx.rt_tile_response_cache
        .set(clock, response_cache_key, json_body.clone());

    Resp::WithBundleHash {
        status: 200,
        content_type: "application/json",
        cache_control: Some(super::route_rt::RT_CACHE_CONTROL),
        body: None,
        json_body: Some(json_body),
        etag: None,
        bundle_hash: Some(bundle_hash.to_string()),
        vary_accept_encoding: true,
    }
}
