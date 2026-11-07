//! `GET /api/<city>/gtfs/manifest` — the schedule-tile bundle manifest.
//!
//! Node parity: `packages/backend/src/routes/gtfsManifest.ts`, mounted
//! internally at `/api/gtfs/manifest` (nginx strips the city segment before
//! proxying to the backend). Like the schedule-tile and rt-tile routes, the
//! real client contract carries the city segment
//! (`packages/frontend/src/services/api.ts` `fetchManifest`), and pt-serve
//! matches that directly — no rewrite.
//!
//! This is the ENTRY POINT of the schedule-tile read path: the frontend calls
//! it on cold load to discover the current `bundleHash`, then addresses every
//! tile by that hash. Subsequent hash changes arrive in-band via the
//! `X-PT-Bundle-Hash` header on tile responses, so a warm client rarely comes
//! back here.
//!
//! ## Where the response comes from
//!
//! Both the body and the ETag are built once per generation load
//! (`bundle::generation::load_schedule_tiles`) and parked on
//! [`Generation::gtfs_manifest_response`]. Node's route is likewise backed by a
//! cached snapshot that it refreshes on an mtime/size change
//! (`gtfs/scheduler.ts` `getManifestSnapshot`). Neither reads the file per
//! request.
//!
//! The body is NOT the on-disk bytes: the producer writes `manifest.json`
//! pretty-printed, while Node replies with `reply.send(snapshot.parsed)` —
//! a compact re-serialisation. See `pt_shared::js_json` for what that costs
//! to reproduce exactly.
//!
//! ## Realtime availability
//!
//! [`gtfs_manifest_with_realtime`] adds `X-PT-Realtime` to the 200 and 304:
//! the GTFS-RT kinds this process is configured to serve (`departures`,
//! `alerts`), computed once at startup, or an empty value. It is a header,
//! not a body field, so the body stays the producer's manifest and the ETag
//! stays that file's hash. It describes configuration, not feed health.
//!
//! ## Deliberate divergences from Node
//!
//! - **No previous-good hash on the 503.** Node's `getLastKnownBundleHash`
//!   exists because its snapshot can go stale mid-rename: the file it reads is
//!   being replaced underneath it, so it retains the last hash it parsed
//!   successfully and reports that while the current read is corrupt. pt-serve
//!   has no such window — a generation is validated in full before it is
//!   adopted and swapped in atomically, so there is no "current is broken,
//!   previous was fine" state to report. A 503 here means this generation has
//!   no schedule-tile build at all, and no hash exists to send.
//! - **`Content-Type` on the 304.** Node omits it; the adapter always stamps
//!   `WithBundleHash::content_type`. Harmless on an empty body, and identical
//!   to the accepted divergence already documented on
//!   [`crate::app::schedule_tile`].

use crate::app::response::{ByteBody, Resp};
use crate::bundle::Generation;
use std::sync::Arc;

/// Node's cold-start reply, byte-for-byte (`routes/gtfsManifest.ts`).
const MANIFEST_UNAVAILABLE_BODY: &str =
    r#"{"error":{"code":"MANIFEST_UNAVAILABLE","message":"No bundle has been published yet"}}"#;

/// Must stay byte-identical to `REALTIME_HEADER` in
/// `packages/shared/src/types/scheduleTile.ts`.
pub const REALTIME_HEADER: &str = "X-PT-Realtime";

/// [`gtfs_manifest`] plus the `X-PT-Realtime` header on its 200 and 304.
/// The 503 is left alone: there is no manifest for the header to describe.
pub fn gtfs_manifest_with_realtime(
    gen: &Generation,
    if_none_match: Option<&str>,
    realtime: &str,
) -> Resp {
    let inner = gtfs_manifest(gen, if_none_match);
    match inner {
        Resp::WithBundleHash {
            status: 200 | 304, ..
        } => Resp::WithHeaders {
            inner: Box::new(inner),
            headers: vec![(REALTIME_HEADER, realtime.to_string())],
        },
        other => other,
    }
}

pub fn gtfs_manifest(gen: &Generation, if_none_match: Option<&str>) -> Resp {
    // `gtfs_manifest_response` and `schedule_tile_manifest` are populated
    // together, so either both are present or neither is.
    let (Some(response), Some(manifest)) = (
        gen.gtfs_manifest_response.as_ref(),
        gen.schedule_tile_manifest.as_ref(),
    ) else {
        return Resp::WithBundleHash {
            status: 503,
            content_type: "application/json",
            cache_control: None,
            body: None,
            json_body: Some(MANIFEST_UNAVAILABLE_BODY.to_string()),
            etag: None,
            // No generation-independent "last known" hash exists — see the
            // module docs.
            bundle_hash: None,
            vary_accept_encoding: false,
        };
    };

    if if_none_match == Some(response.etag.as_str()) {
        // Node's 304 carries ETag + X-PT-Bundle-Hash only: no Cache-Control,
        // no Vary.
        return Resp::WithBundleHash {
            status: 304,
            content_type: "application/json",
            cache_control: None,
            body: None,
            json_body: None,
            etag: Some(response.etag.clone()),
            bundle_hash: Some(manifest.bundle_hash.clone()),
            vary_accept_encoding: false,
        };
    }

    Resp::WithBundleHash {
        status: 200,
        content_type: "application/json",
        // `no-cache` = revalidate every time; the ETag is what makes that cheap.
        cache_control: Some("no-cache"),
        body: Some(ByteBody::Raw(Arc::clone(&response.body))),
        json_body: None,
        etag: Some(response.etag.clone()),
        bundle_hash: Some(manifest.bundle_hash.clone()),
        vary_accept_encoding: true,
    }
}
