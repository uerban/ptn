//! Transport-agnostic response shape produced by `app::*` handlers.
//!
//! They build a [`Resp`] instead — a tiny intermediate the `http::adapter` translates to a
//! `tiny_http::ResponseBox` once, at the seam.
//!
//! The enum is deliberately minimal: a JSON arm for the JSON endpoints, a
//! `Bytes` arm for `/raptor-bundle` + `/transfers/fetch` (which need streaming
//! from an `Arc<Mmap>` refcount instead of a body Vec), a thin 304 arm, and a
//! plain-text arm for `/metrics`. The adapter expands each into the tiny_http
//! body cursor it needs.

use crate::mmap::MmapBytes;
use std::io::Cursor;
use std::sync::Arc;

/// Cheap-to-clone body handle for byte responses. Mirrors the two body kinds
/// the P3 handlers already built: a raw mmap refcount (`Arc<Mmap>`, served
/// via `MmapBytes` so cursored I/O sees `&[u8]`), or a lazily-built gzip buffer.
pub enum ByteBody {
    /// Stream straight from the read-only mmap — no body copy.
    Mmap(MmapBytes),
    /// Stream from a lazily-built gzip buffer — one `Arc` bump per response.
    Gzip(Arc<[u8]>),
    /// Owned heap bytes served as-is (identity, NOT gzip). Used for the
    /// Rust-serialized shapes JSON and the verbatim color-config blob.
    Raw(Arc<[u8]>),
}

impl ByteBody {
    pub fn len(&self) -> usize {
        match self {
            ByteBody::Mmap(m) => m.as_ref().len(),
            ByteBody::Gzip(g) => g.len(),
            ByteBody::Raw(r) => r.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn is_gzip(&self) -> bool {
        matches!(self, ByteBody::Gzip(_))
    }
}

/// Reader yielding the body bytes — built by the adapter for `tiny_http`'s
/// streaming `Response::new` constructor. Erases `ByteBody`'s discriminant
/// behind a `Box<dyn Read + Send>` so the adapter can pass the same handle
/// regardless of source.
impl ByteBody {
    pub fn into_reader(self) -> Box<dyn std::io::Read + Send> {
        match self {
            ByteBody::Mmap(m) => Box::new(Cursor::new(m)),
            ByteBody::Gzip(g) => Box::new(Cursor::new(g)),
            ByteBody::Raw(r) => Box::new(Cursor::new(r)),
        }
    }
}

/// Content-addressed artifact provenance for a `/raptor-bundle` response. Carried on the
/// `Resp::Bytes`/`Resp::NotModified` the raptor-bundle handler builds so the
/// `http::adapter` can stamp the transfer or route-geometry artifact headers.
/// `None` means the corresponding capability marker is still emitted while
/// its three artifact headers are omitted.
#[derive(Clone)]
pub struct ArtifactProvenance {
    /// Public fetch URL.
    pub url: String,
    /// UNQUOTED lowercase-hex SHA-256 of the artifact bytes. Not the quoted
    /// ETag form.
    pub hash: String,
    /// Artifact length in bytes.
    pub size: u64,
}

/// Raptor-bundle provenance payload. Its mere presence on a `Resp::Bytes` /
/// `Resp::NotModified` marks the response as a raptor-bundle response: the
/// adapter then emits `X-PT-Raptor-Bundle-Provenance: transfers-v1` (the
/// transfer capability marker, ALWAYS), `X-PT-City-Tz-Iana` when the active
/// generation resolved an IANA timezone, plus the 3
/// `X-PT-Transfers-Artifact-*` headers (only when [`Self::transfers`] is
/// `Some`). Scoped this way so bundle metadata never leaks onto
/// `transfers_fetch` / `shapes` byte responses, which set `provenance: None`.
#[derive(Clone)]
pub struct RaptorBundleProvenance {
    /// Authoritative IANA timezone of the active generation. The same value is
    /// exposed by `/ready`; carrying it on both 200 and 304 bundle responses
    /// lets offline clients persist it atomically with the PTB it describes.
    pub city_tz_iana: Option<String>,
    /// `Some` => emit the 3 artifact headers; `None` => only the capability marker.
    pub transfers: Option<ArtifactProvenance>,
    /// `Some` => emit the route-geometry artifact headers. The independent
    /// capability marker is emitted even when this is `None`.
    pub route_geometry: Option<ArtifactProvenance>,
}

/// Response handed back by `app::*` handlers. Each variant carries the
/// minimum the `http::adapter` needs to materialise a transport response.
pub enum Resp {
    /// JSON body, arbitrary status. The adapter sets `Content-Type:
    /// application/json` automatically.
    Json { status: u16, body: String },
    /// Plain text body (used by `/metrics`). The adapter sets `Content-Type:
    /// text/plain; version=0.0.4`.
    Prometheus { body: String },
    /// 200 streaming bytes response with explicit `ETag` + a `Vary:
    /// Accept-Encoding` echo. The byte handlers build this.
    Bytes {
        body: ByteBody,
        etag: String,
        /// True iff the body is gzipped — adapter adds
        /// `Content-Encoding: gzip` accordingly.
        gzipped: bool,
        /// Live PTB header version of the generation that produced these
        /// bytes (`reader.header().version`). Emitted as `X-Ptb-Version` so
        /// an operator can confirm which on-disk format is actually being
        /// served.
        ptb_version: u16,
        /// `Some` only for `/raptor-bundle` responses — drives the
        /// `X-PT-Raptor-Bundle-Provenance`, `X-PT-City-Tz-Iana`, and
        /// `X-PT-Transfers-Artifact-*` headers plus the raptor-bundle-specific
        /// Cache-Control. `None` for every other byte route
        /// (`transfers_fetch`), which must NOT carry bundle metadata.
        provenance: Option<RaptorBundleProvenance>,
    },
    /// 304 Not Modified — echo `ETag` + `Vary: Accept-Encoding`, empty body.
    /// `provenance` is `Some` only for `/raptor-bundle` 304s (see
    /// [`Resp::Bytes`]); the marker + fresh transfer headers ride the 304 so a
    /// transfer-only change (same PTB ETag) reaches the client without a PTB
    /// redownload.
    NotModified {
        etag: String,
        provenance: Option<RaptorBundleProvenance>,
    },
    /// 404 Not Found — empty body, status only. Used by `/transfers/fetch`
    /// when no transfers artifact is loaded.
    NotFoundEmpty,
    /// 204 No Content — no body, no `Content-Type`, and deliberately no
    /// `Content-Length`. RFC 7230 forbids `Content-Length` on a 204, so
    /// this cannot be spelled as `Resp::Json { status: 204, body: String::new() }`:
    /// that arm goes through `Response::from_data`, which sets a length and a
    /// JSON content-type on a response that has neither. Used by
    /// `POST /api/<city>/client-report`, matching Fastify's `reply.status(204).send()`.
    NoContent,
    /// Bytes response with caller-controlled cache/type headers — the C2 read
    /// routes need exact backend parity (JSON content-type, route-specific
    /// Cache-Control, optional strong ETag). `Vary`/`Content-Encoding` are added
    /// only when `gzipped`. The adapter also stamps `X-API-Version: 1`.
    CachedBytes {
        status: u16,
        body: ByteBody,
        content_type: &'static str,
        cache_control: &'static str,
        etag: Option<String>,
        gzipped: bool,
    },
    /// Byte or JSON-error response carrying an optional `X-PT-Bundle-Hash`
    /// header — needed by the schedule-tile route family (and, per the
    /// rtTile follow-up scoping, its future RT-overlay sibling, which has
    /// the identical `bundle_hash_mismatch`/`tile_not_found` error shape).
    /// No existing arm above carries an extra header, and `Json`/`CachedBytes`
    /// have too many call sites to widen safely for one route family — this
    /// is purely additive. `body` covers the byte-tile success/304 arms;
    /// `json_body` covers the 400/404/409/503 structured-error arms. At most
    /// one of `body`/`json_body` is `Some`; both `None` serialises to an
    /// empty response body (the 304 case, where `etag` carries the value
    /// instead).
    WithBundleHash {
        status: u16,
        content_type: &'static str,
        cache_control: Option<&'static str>,
        body: Option<ByteBody>,
        json_body: Option<String>,
        etag: Option<String>,
        /// Emitted as `X-PT-Bundle-Hash` iff `Some` — omitted on the
        /// schedule-tile route's three 400s, where no hash is known yet.
        bundle_hash: Option<String>,
        /// Emits `Vary: Accept-Encoding` iff `true` — only the rt-tile
        /// route's 200 responses (cache-hit and fresh) set this, matching
        /// Node's `rtTile.ts` exactly (its 400/404/409/503 error replies
        /// carry no `Vary`). `schedule_tile` never sets this to `true`.
        vary_accept_encoding: bool,
    },
    /// Any other response plus extra headers, appended after the inner
    /// response's own. Used by `/gtfs/manifest` for `X-PT-Realtime`, so its
    /// body and ETag come from the unchanged inner response.
    WithHeaders {
        inner: Box<Resp>,
        headers: Vec<(&'static str, String)>,
    },
    /// Byte or JSON-error response for the poi-tile route. Distinct from
    /// [`Resp::WithBundleHash`]: no `X-PT-Bundle-Hash` (POI bundles carry
    /// no GTFS bundle-hash concept) and no `Vary: Accept-Encoding` (Node's
    /// `poiTile.ts` never sets one, unlike rt-tile).
    PoiTile {
        status: u16,
        content_type: &'static str,
        cache_control: Option<&'static str>,
        /// `Some` (200) always carries an adapter-added
        /// `Content-Encoding: br` — Node's route emits it only from the
        /// 200 branch's own header calls, never on the empty-body 304.
        body: Option<ByteBody>,
        json_body: Option<String>,
        etag: Option<String>,
        /// `X-POI-Attribution`/`X-POI-License` are emitted iff `true`.
        /// Mirrors Node's header-chain ordering: Cache-Control/ETag/
        /// Attribution/License are set BEFORE the if-none-match check, so
        /// both 200 and 304 carry them — `true` on those two paths only,
        /// `false` on every 400/404/503 early-return error, which never
        /// reaches that chain in Node.
        attribution: bool,
    },
}
