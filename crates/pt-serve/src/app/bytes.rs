//! `/raptor-bundle` and its binary sidecars — streaming byte responses.
//!
//! Reads ETag + lazily-built gzip from the active [`Generation`]; the dispatcher
//! probes `If-None-Match` and gzip-accept on the request side and threads those
//! booleans down through these functions.

use crate::app::response::{ArtifactProvenance, ByteBody, RaptorBundleProvenance, Resp};
use crate::bundle::{generation::gzip, Generation};
use std::sync::Arc;

/// `GET /api/<city>/raptor-bundle`
///
/// Emits generation metadata on both 200 and 304 responses: the authoritative
/// `X-PT-City-Tz-Iana` when the generation resolved one, plus the existing
/// transfer-provenance headers. The PTB `ETag` stays derived from PTB bytes
/// only (`gen.bundle_etag`); metadata changes ride the mandatory revalidation
/// response without forcing a PTB redownload.
///
/// `city` is the served slug (`gen.city_slug`), used only to build the
/// artifact URL.
pub fn raptor_bundle(
    gen: &Generation,
    if_none_match: Option<&str>,
    accept_gzip: bool,
    city: &str,
) -> Resp {
    let etag = &gen.bundle_etag;
    // Live on-disk format version of the bundle being served — sourced from
    // the loaded header, never the compile-time const, so the emitted
    // `X-Ptb-Version` reports the bytes actually being served.
    let ptb_version = gen.reader.header().version;

    // Transfer provenance, recomputed per response from the active generation.
    // `transfers_etag` is the QUOTED ETag form of the artifact's sha256; the
    // wire hash header must be the UNQUOTED lowercase-hex digest for byte-parity
    // with Node's `getArtifactMeta().hash`, so strip the surrounding quotes.
    let provenance = RaptorBundleProvenance {
        city_tz_iana: (!gen.city_tz_iana.is_empty()).then(|| gen.city_tz_iana.clone()),
        transfers: gen.transfers_etag.as_ref().map(|h| ArtifactProvenance {
            url: format!("/api/{city}/transfers/fetch"),
            hash: h.trim_matches('"').to_string(),
            size: gen.transfers_bytes_len(),
        }),
        route_geometry: gen
            .route_geometry_etag
            .as_ref()
            .map(|h| ArtifactProvenance {
                url: format!("/api/{city}/route-geometry/fetch"),
                hash: h.trim_matches('"').to_string(),
                size: gen.route_geometry_bytes_len(),
            }),
    };

    if if_none_match == Some(etag.as_str()) {
        return Resp::NotModified {
            etag: etag.clone(),
            provenance: Some(provenance),
        };
    }

    if accept_gzip {
        // Lazy: first hit gzips + faults the whole file. /raptor-bundle is
        // bench/parity-only — never hit during the /plan bench — so this
        // never pollutes steady-state RSS.
        let gz = gen
            .bundle_gzip
            .get_or_init(|| Arc::from(gzip(gen.bundle_bytes().as_ref())));
        Resp::Bytes {
            body: ByteBody::Gzip(Arc::clone(gz)),
            etag: etag.clone(),
            gzipped: true,
            ptb_version,
            provenance: Some(provenance),
        }
    } else {
        Resp::Bytes {
            body: ByteBody::Mmap(gen.bundle_bytes()),
            etag: etag.clone(),
            gzipped: false,
            ptb_version,
            provenance: Some(provenance),
        }
    }
}

/// `GET /api/<city>/transfers/fetch`
pub fn transfers_fetch(gen: &Generation, if_none_match: Option<&str>, accept_gzip: bool) -> Resp {
    let (Some(bytes), Some(etag)) = (gen.transfers_bytes(), gen.transfers_etag.as_ref()) else {
        return Resp::NotFoundEmpty;
    };
    // The transfers artifact is served by a generation whose bundle is at
    // this header version — carry it on the response for the same operator
    // confirmation signal as the bundle route.
    let ptb_version = gen.reader.header().version;

    if if_none_match == Some(etag.as_str()) {
        // No provenance: the capability marker is scoped to /raptor-bundle.
        return Resp::NotModified {
            etag: etag.clone(),
            provenance: None,
        };
    }

    if accept_gzip {
        let gz = gen
            .transfers_gzip
            .get_or_init(|| Arc::from(gzip(bytes.as_ref())));
        Resp::Bytes {
            body: ByteBody::Gzip(Arc::clone(gz)),
            etag: etag.clone(),
            gzipped: true,
            ptb_version,
            provenance: None,
        }
    } else {
        Resp::Bytes {
            body: ByteBody::Mmap(bytes),
            etag: etag.clone(),
            gzipped: false,
            ptb_version,
            provenance: None,
        }
    }
}

/// `GET /api/<city>/route-geometry/fetch`
pub fn route_geometry_fetch(
    gen: &Generation,
    if_none_match: Option<&str>,
    accept_gzip: bool,
) -> Resp {
    let (Some(bytes), Some(etag)) = (gen.route_geometry_bytes(), gen.route_geometry_etag.as_ref())
    else {
        return Resp::NotFoundEmpty;
    };
    let ptb_version = gen.reader.header().version;

    if if_none_match == Some(etag.as_str()) {
        return Resp::NotModified {
            etag: etag.clone(),
            provenance: None,
        };
    }

    if accept_gzip {
        let gz = gen
            .route_geometry_gzip
            .get_or_init(|| Arc::from(gzip(bytes.as_ref())));
        Resp::Bytes {
            body: ByteBody::Gzip(Arc::clone(gz)),
            etag: etag.clone(),
            gzipped: true,
            ptb_version,
            provenance: None,
        }
    } else {
        Resp::Bytes {
            body: ByteBody::Mmap(bytes),
            etag: etag.clone(),
            gzipped: false,
            ptb_version,
            provenance: None,
        }
    }
}
