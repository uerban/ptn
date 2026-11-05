//! `GET /api/<city>/gtfs/schedule-tile/<bundleHash>/<tileSize>/<tileCoords>`
//! — content-addressed brotli-compressed schedule tile bytes. Parity with
//! the Node route `packages/backend/src/routes/scheduleTile.ts`: a pure
//! byte-proxy (no server-side brotli decode, no JSON decode of the tile
//! body — that happens client-side).
//!
//! ## Adaptation from Node's bundle-hash guard
//!
//! Node's `dataDir` can hold multiple bundle-hash subdirectories at once
//! (producer-mode staging), so it distinguishes three 409 sub-cases: stale
//! hash (guard fails, current known), unavailable (hash matches current but
//! the dir isn't there yet — cold start), and unavailable (no current hash
//! known at all — cold start with nothing published). pt-serve has exactly
//! ONE active [`Generation`] at a time — there is no second hash's data
//! ever available — so the three collapse to two: `bundle_hash_mismatch`
//! when the requested hash isn't the serving generation's, `bundle_unavailable`
//! when it IS but this generation has no schedule-tile build (older
//! generation, or one built before PR #412). The response bodies for each
//! CLIENT-VISIBLE scenario are unchanged; only the internal branching
//! collapses.
//!
//! ## Minor deliberate header divergences from Node
//!
//! Node's 304 response omits `Content-Type`; this handler sets it anyway
//! (the adapter always stamps `WithBundleHash::content_type`) — harmless on
//! an empty body. Node's `TILE_READ_ERROR` 503 omits `X-PT-Bundle-Hash`;
//! this handler includes it (the hash that failed to read is useful
//! operator/client context). Neither client depends on the absence of
//! either header.

use crate::app::response::{ByteBody, Resp};
use crate::bundle::Generation;
use crate::ops::tile_cache::CachedTile;
use crate::ops::ServerCtx;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use pt_shared::tile_coord::{parse_tile_coords, SCHEDULE_TILE_SIZE_LABEL};
use std::sync::Arc;

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

/// Build the 200/304 byte response from a cached (or freshly-read) tile,
/// honouring `If-None-Match`. Shared by the cache-hit path and the fresh-read
/// path — a hit implies this exact tile already passed every gate below when
/// it was first cached (tiles are immutable per `(bundleHash, tileSize,
/// tileCoords)`).
fn serve_tile(tile: &CachedTile, bundle_hash: &str, if_none_match: Option<&str>) -> Resp {
    if if_none_match == Some(tile.etag.as_str()) {
        return Resp::WithBundleHash {
            status: 304,
            content_type: "application/octet-stream",
            cache_control: None,
            body: None,
            json_body: None,
            etag: Some(tile.etag.clone()),
            bundle_hash: Some(bundle_hash.to_string()),
            vary_accept_encoding: false,
        };
    }
    Resp::WithBundleHash {
        status: 200,
        content_type: "application/octet-stream",
        cache_control: Some("public, max-age=31536000, immutable"),
        body: Some(ByteBody::Raw(Arc::clone(&tile.bytes))),
        json_body: None,
        etag: Some(tile.etag.clone()),
        bundle_hash: Some(bundle_hash.to_string()),
        vary_accept_encoding: false,
    }
}

pub fn schedule_tile(
    ctx: &ServerCtx,
    gen: &Generation,
    bundle_hash: &str,
    tile_size: &str,
    tile_coords: &str,
    if_none_match: Option<&str>,
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
                r#"{{"error":{{"code":"TILE_SIZE_MISMATCH","message":"Server uses {SCHEDULE_TILE_SIZE_LABEL}; got {tile_size}"}}}}"#
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

    // ---- 409 bundle_hash_mismatch: pt-serve's one-generation-at-a-time
    // collapse of Node's stale-hash sub-case (see module doc). ----
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

    // Cache is keyed by (tileSize, tileCoords) and gated by the
    // GENERATION EPOCH (not the hash — see `ops/tile_cache.rs`'s
    // "Generation-race safety" doc), which rolls the cache forward and
    // rejects any write/read from a superseded generation without ever
    // moving backward. A hit skips the subdivision/disk gates below
    // entirely — they were already settled when this exact tile was first
    // cached.
    let cache_key = format!("{tile_size}/{tile_coords}");
    if let Some(cached) = ctx.tile_cache.get(gen.epoch, &cache_key) {
        return serve_tile(&cached, &gen.generation_id, if_none_match);
    }

    // ---- 409 bundle_unavailable: pt-serve's collapse of Node's two
    // "dir missing" sub-cases (see module doc). Node's gate is
    // `existsSync(bundleDir)` — mirrored here as an explicit directory
    // check, not merely "did the manifest parse", since
    // `schedule_tiles_dir` is a computed path that may not exist on disk
    // even when the manifest did (e.g. a build that wrote manifest.json
    // but crashed before writing any tile). ----
    let (Some(manifest), Some(tiles_dir)) = (&gen.schedule_tile_manifest, &gen.schedule_tiles_dir)
    else {
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

    // ---- 404 subdivision gate — must run before the on-disk existence
    // check (a subdivided cell's bare tile never existed on disk at all). ----
    let plan = manifest
        .subdivisions
        .as_ref()
        .and_then(|s| s.get(&parsed.cell_key));
    if parsed.suffix.is_empty() {
        if let Some(plan) = plan {
            let leaves: Vec<String> = plan.leaves.iter().map(|l| l.suffix.clone()).collect();
            let leaves_json = leaves
                .iter()
                .map(|s| format!("\"{s}\""))
                .collect::<Vec<_>>()
                .join(",");
            return json_error(
                404,
                Some(gen.generation_id.clone()),
                format!(r#"{{"error":"tile_subdivided","leaves":[{leaves_json}]}}"#),
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

    // ---- 404 on-disk existence + 503 read error ----
    let tile_path = tiles_dir.join(tile_size).join(format!("{tile_coords}.br"));
    let bytes = match std::fs::read(&tile_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return json_error(
                404,
                Some(gen.generation_id.clone()),
                r#"{"error":"tile_not_found"}"#.to_string(),
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

    let etag = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&bytes);
        let b64 = BASE64.encode(digest);
        format!("\"{}\"", &b64[..16])
    };
    let cached = CachedTile {
        bytes: Arc::from(bytes.into_boxed_slice()),
        etag,
    };
    ctx.tile_cache.set(gen.epoch, cache_key, cached.clone());
    serve_tile(&cached, &gen.generation_id, if_none_match)
}
