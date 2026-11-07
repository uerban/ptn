//! `tiny_http` ↔ `app::Resp` translation layer.
//!
//! This is the SINGLE file in the crate (besides `http::dispatch` and the `bin/main.rs` bind site)
//! that is allowed to import `tiny_http`.

use crate::app::response::{RaptorBundleProvenance, Resp};
use serde::Serialize;
use std::io::Cursor;
use tiny_http::{Header, Request, Response, ResponseBox, StatusCode};

/// In-band bundle-hash discovery header. Must stay byte-identical to the Node
/// plane's `BUNDLE_HASH_HEADER` (`packages/shared/src/types/scheduleTile.ts`) —
/// `route-parity-check.mjs` compares it across both planes and asserts it is
/// PRESENT, so a one-sided rename fails the parity gate rather than passing
/// vacuously.
///
/// `ptn` is the outward-facing name, `pt` the internal one, and the bundle is
/// an internal artifact.
pub const BUNDLE_HASH_HEADER: &str = "X-PT-Bundle-Hash";

/// Token-aware gzip detection with RFC 7231 q-value handling — mirrors Node's
/// `/\bgzip\b/i`. See the deleted `handlers::bytes::accepts_gzip` for the
/// original commentary.
pub fn accepts_gzip(req: &Request) -> bool {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("Accept-Encoding"))
        .map(|h| {
            h.value.as_str().split(',').any(|part| {
                let mut segs = part.split(';');
                let token = segs.next().unwrap_or("").trim();
                if !token.eq_ignore_ascii_case("gzip") {
                    return false;
                }
                !segs.any(|param| {
                    let mut kv = param.splitn(2, '=');
                    let key = kv.next().unwrap_or("").trim();
                    if !key.eq_ignore_ascii_case("q") {
                        return false;
                    }
                    kv.next()
                        .and_then(|v| v.trim().parse::<f32>().ok())
                        .map(|q| q <= 0.0)
                        .unwrap_or(false)
                })
            })
        })
        .unwrap_or(false)
}

/// Lookup `If-None-Match` on the request — returned as an owned `String` so the
/// app layer can borrow it without dragging tiny_http's request lifetime
/// upward.
pub fn if_none_match(req: &Request) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("If-None-Match"))
        .map(|h| h.value.as_str().to_string())
}

/// Lookup `If-Generation-Match` on the request — the C2c
/// `/scheduled-departures-for-stop` precondition header. Returned as an owned
/// `String` (mirrors [`if_none_match`]) so the app layer borrows it without
/// dragging the tiny_http request lifetime upward.
pub fn if_generation_match(req: &Request) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("If-Generation-Match"))
        .map(|h| h.value.as_str().to_string())
}

fn hdr(name: &str, value: &str) -> Header {
    // `Header::from_bytes` fails on non-ASCII / CR / LF in name or value.
    // All call sites pass static literals or generated hex/ASCII fields
    // (etag, content-type, encoding), so this expect documents the
    // invariant rather than guarding a runtime path. Fall back to a
    // sentinel header on a degenerate value (e.g. an ETag string that
    // somehow contained a newline from a corrupted source) so the
    // response still serialises without panicking.
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap_or_else(|_| {
        Header::from_bytes(&b"X-PtServe-Error"[..], &b"header-invalid"[..])
            .expect("static sentinel header is always valid")
    })
}

fn ok_byte_headers(
    etag: &str,
    gzipped: bool,
    ptb_version: u16,
    cache_control: &str,
) -> Vec<Header> {
    let mut headers = vec![
        hdr("Content-Type", "application/octet-stream"),
        hdr("ETag", etag),
        hdr("Cache-Control", cache_control),
        hdr("Vary", "Accept-Encoding"),
        // Live on-disk format version of the served generation (sourced from
        // the bundle header, not the compile-time const).
        hdr("X-Ptb-Version", &ptb_version.to_string()),
    ];
    if gzipped {
        headers.push(hdr("Content-Encoding", "gzip"));
    }
    headers
}

/// Build the `/raptor-bundle` metadata headers. Shared by the 200
/// (`Resp::Bytes`) and 304 (`Resp::NotModified`) arms so clients can atomically
/// backfill metadata without downloading unchanged PTB bytes.
fn provenance_headers(p: &RaptorBundleProvenance) -> Vec<Header> {
    let mut headers = vec![
        hdr("X-PT-Raptor-Bundle-Provenance", "transfers-v1"),
        hdr("X-PT-Route-Geometry-Provenance", "shpb-v1"),
    ];
    if let Some(city_tz_iana) = p.city_tz_iana.as_ref() {
        headers.push(hdr("X-PT-City-Tz-Iana", city_tz_iana));
    }
    if let Some(t) = p.transfers.as_ref() {
        headers.push(hdr("X-PT-Transfers-Artifact-Url", &t.url));
        headers.push(hdr("X-PT-Transfers-Artifact-Hash", &t.hash));
        headers.push(hdr("X-PT-Transfers-Artifact-Size", &t.size.to_string()));
    }
    if let Some(g) = p.route_geometry.as_ref() {
        headers.push(hdr("X-PT-Route-Geometry-Artifact-Url", &g.url));
        headers.push(hdr("X-PT-Route-Geometry-Artifact-Hash", &g.hash));
        headers.push(hdr(
            "X-PT-Route-Geometry-Artifact-Size",
            &g.size.to_string(),
        ));
    }
    headers
}

/// Translate an `app::Resp` into a `tiny_http::ResponseBox`. Centralising this
/// keeps the JSON, gzip, and ETag headers in one place; the app handlers stay
/// transport-agnostic.
pub fn to_tiny_http(resp: Resp) -> ResponseBox {
    match resp {
        Resp::Json { status, body } => Response::from_data(body.into_bytes())
            .with_status_code(status)
            .with_header(hdr("Content-Type", "application/json"))
            .boxed(),
        Resp::Prometheus { body } => Response::from_data(body.into_bytes())
            .with_status_code(200)
            .with_header(hdr("Content-Type", "text/plain; version=0.0.4"))
            .boxed(),
        Resp::Bytes {
            body,
            etag,
            gzipped,
            ptb_version,
            provenance,
        } => {
            let len = body.len();
            // raptor-bundle (provenance present) uses the store-but-revalidate
            // Cache-Control in parity with the Node route — the sidecar can
            // atomic-rename the PTB at any time, so intermediates must revalidate
            // via the strong ETag every request. transfers_fetch keeps its
            // longer-lived max-age=300.
            let cache_control = if provenance.is_some() {
                "public, max-age=0, must-revalidate"
            } else {
                "public, max-age=300"
            };
            let mut headers = ok_byte_headers(&etag, gzipped, ptb_version, cache_control);
            if let Some(p) = provenance.as_ref() {
                headers.extend(provenance_headers(p));
            }
            let reader = body.into_reader();
            Response::new(StatusCode(200), headers, reader, Some(len), None).boxed()
        }
        Resp::NotModified { etag, provenance } => {
            let mut response = Response::from_data(Vec::new())
                .with_status_code(304)
                .with_header(hdr("Vary", "Accept-Encoding"))
                .with_header(hdr("ETag", &etag));
            if let Some(p) = provenance.as_ref() {
                // raptor-bundle 304: carry the revalidate Cache-Control + the
                // FRESH transfer provenance (parity with the Node 304 branch) so
                // a transfer-only change reaches the client without a PTB
                // redownload.
                response = response
                    .with_header(hdr("Cache-Control", "public, max-age=0, must-revalidate"));
                for h in provenance_headers(p) {
                    response = response.with_header(h);
                }
            }
            response.boxed()
        }
        Resp::NotFoundEmpty => Response::from_data(Vec::new())
            .with_status_code(404)
            .boxed(),
        // KNOWN DIVERGENCE from Node, forced by tiny_http 0.12 — the same
        // class as the 304 note above, and worth stating for the same reason.
        //
        // This 204 goes out carrying `Content-Length: 0`, where Fastify's
        // `.status(204).send()` sends no Content-Length at all. RFC 7230
        // says a server MUST NOT send one on a 204, so Fastify is right and we
        // are not. It is not fixable through tiny_http's public API: 204
        // resolves to Identity in `choose_transfer_encoding`, and the Identity
        // branch of `raw_print` writes `Content-Length: {}` from
        // `entity_length.unwrap_or(0)` — so a `None` length yields the same
        // `0` rather than omitting the header. `Response::empty` is therefore
        // used for clarity; the explicit `Response::new(.., None, None)`
        // spelling produces identical bytes.
        //
        // Harmless in practice: `Content-Length: 0` and an absent
        // Content-Length frame an empty body identically for every client, and
        // the one caller (`sendClientReport`) ignores the response entirely.
        // What DOES matter and is preserved: no Content-Type, no body, and no
        // chunked framing.
        Resp::NoContent => Response::empty(StatusCode(204)).boxed(),
        Resp::CachedBytes {
            status,
            body,
            content_type,
            cache_control,
            etag,
            gzipped,
        } => {
            let len = body.len();
            let mut headers = vec![
                hdr("Content-Type", content_type),
                hdr("Cache-Control", cache_control),
                hdr("X-API-Version", "1"),
            ];
            if let Some(e) = etag.as_deref() {
                headers.push(hdr("ETag", e));
            }
            if gzipped {
                headers.push(hdr("Vary", "Accept-Encoding"));
                headers.push(hdr("Content-Encoding", "gzip"));
            }
            let reader = body.into_reader();
            Response::new(StatusCode(status), headers, reader, Some(len), None).boxed()
        }
        Resp::WithBundleHash {
            status,
            content_type,
            cache_control,
            body,
            json_body,
            etag,
            bundle_hash,
            vary_accept_encoding,
        } => {
            let mut headers = vec![hdr("Content-Type", content_type)];
            if let Some(cc) = cache_control {
                headers.push(hdr("Cache-Control", cc));
            }
            if let Some(e) = etag.as_deref() {
                headers.push(hdr("ETag", e));
            }
            if let Some(h) = bundle_hash.as_deref() {
                headers.push(hdr(BUNDLE_HASH_HEADER, h));
            }
            if vary_accept_encoding {
                headers.push(hdr("Vary", "Accept-Encoding"));
            }
            // At most one of `body`/`json_body` is `Some` (see the variant
            // doc); both `None` is the 304 empty-body case.
            match (body, json_body) {
                (Some(b), None) => {
                    let len = b.len();
                    let reader = b.into_reader();
                    Response::new(StatusCode(status), headers, reader, Some(len), None).boxed()
                }
                (None, json) => {
                    let bytes = json.map(String::into_bytes).unwrap_or_default();
                    headers
                        .into_iter()
                        .fold(
                            Response::from_data(bytes).with_status_code(status),
                            |r, h| r.with_header(h),
                        )
                        .boxed()
                }
                (Some(_), Some(_)) => {
                    unreachable!("Resp::WithBundleHash: body and json_body are mutually exclusive")
                }
            }
        }
        Resp::WithHeaders { inner, headers } => headers
            .iter()
            .fold(to_tiny_http(*inner), |r, (name, value)| {
                r.with_header(hdr(name, value))
            }),
        Resp::PoiTile {
            status,
            content_type,
            cache_control,
            body,
            json_body,
            etag,
            attribution,
        } => {
            let mut headers = Vec::from(poi_response_headers());
            if status != 304 {
                headers.push(hdr("Content-Type", content_type));
            }
            if let Some(cc) = cache_control {
                headers.push(hdr("Cache-Control", cc));
            }
            if let Some(e) = etag.as_deref() {
                headers.push(hdr("ETag", e));
            }
            if attribution {
                headers.push(hdr("X-POI-Attribution", "(c) OpenStreetMap contributors"));
                headers.push(hdr(
                    "X-POI-License",
                    "https://opendatacommons.org/licenses/odbl/",
                ));
            }
            match (body, json_body) {
                (Some(b), None) => {
                    headers.push(hdr("Content-Encoding", "br"));
                    let len = b.len();
                    let reader = b.into_reader();
                    Response::new(StatusCode(status), headers, reader, Some(len), None)
                        .with_chunked_threshold(usize::MAX)
                        .boxed()
                }
                (None, None) if status == 304 => {
                    // KNOWN DIVERGENCE from Node, forced by tiny_http 0.12: this 304
                    // goes out carrying `Transfer-Encoding: chunked`, where Fastify
                    // sends neither Transfer-Encoding nor Content-Length.
                    //
                    // `choose_transfer_encoding` returns Identity only for
                    // `status < 200 || status == 204` (the MUST-NOT in RFC 7230
                    // covers exactly those; 304 is not in it), then falls
                    // through to
                    // `entity_length.map_or(true, |v| *v >= chunked_threshold)`.
                    // `map_or` yields its DEFAULT `true` for a None length without
                    // calling the closure, so Chunked is selected regardless of the
                    // threshold — `with_chunked_threshold` cannot suppress it here.
                    // The only alternative, `data_length: Some(0)`, selects Identity,
                    // which asserts a length and emits `Content-Length: 0` — also
                    // unlike Node, and semantically wrong for a 304 (RFC 9112
                    // wants the length the 200 WOULD have had, not zero).
                    //
                    // Harmless in practice: tiny_http's `do_not_send_body` does cover
                    // 304, so no entity bytes and no chunk terminator are written, and
                    // HTTP/1.1 clients never read a body for a 304. Left as-is rather
                    // than trading one divergence for another; revisit if tiny_http
                    // gains a bodyless-response path.
                    Response::new(StatusCode(status), headers, std::io::empty(), None, None).boxed()
                }
                (None, json) => {
                    let bytes = json.map(String::into_bytes).unwrap_or_default();
                    headers
                        .into_iter()
                        .fold(
                            Response::from_data(bytes)
                                .with_status_code(status)
                                .with_chunked_threshold(usize::MAX),
                            |r, h| r.with_header(h),
                        )
                        .boxed()
                }
                (Some(_), Some(_)) => {
                    unreachable!("Resp::PoiTile: body and json_body are mutually exclusive")
                }
            }
        }
    }
}

fn request_header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn poi_response_headers() -> [Header; 3] {
    [
        hdr("X-App-Version", env!("PT_SERVE_APP_VERSION")),
        hdr("X-App-Commit", env!("PT_SERVE_GIT_SHA")),
        hdr("X-API-Version", "1"),
    ]
}

fn add_poi_cors(mut response: ResponseBox, request: &Request) -> ResponseBox {
    response.add_header(hdr("Vary", "Origin"));
    if let Some(origin) = request_header(request, "Origin") {
        response.add_header(hdr("Access-Control-Allow-Origin", origin));
    }
    response
}

/// Translate a regular POI handler response and apply the global Fastify CORS
/// hook that wraps the Node route.
pub fn to_tiny_http_poi(resp: Resp, request: &Request) -> ResponseBox {
    add_poi_cors(to_tiny_http(resp), request)
}

/// Fastify's `@fastify/cors` wildcard OPTIONS route answers before POI route
/// lookup and before the handler.
pub fn poi_preflight(request: &Request) -> ResponseBox {
    let origin = request_header(request, "Origin").filter(|value| !value.is_empty());
    let request_method =
        request_header(request, "Access-Control-Request-Method").filter(|value| !value.is_empty());
    if origin.is_none() || request_method.is_none() {
        let mut response = Response::from_data(b"Invalid Preflight Request".to_vec())
            .with_status_code(400)
            .with_header(hdr("Content-Type", "text/plain"))
            .with_header(hdr("Cache-Control", "no-store"));
        for header in poi_response_headers() {
            response = response.with_header(header);
        }
        return add_poi_cors(response.boxed(), request);
    }

    let mut response = Response::empty(StatusCode(204));
    response.add_header(hdr("Vary", "Origin, Access-Control-Request-Headers"));
    response.add_header(hdr("Access-Control-Allow-Methods", "GET,HEAD,POST"));
    response.add_header(hdr("Cache-Control", "no-store"));
    for header in poi_response_headers() {
        response.add_header(header);
    }
    if let Some(origin) = origin {
        response.add_header(hdr("Access-Control-Allow-Origin", origin));
    }
    if let Some(headers) =
        request_header(request, "Access-Control-Request-Headers").filter(|value| !value.is_empty())
    {
        response.add_header(hdr("Access-Control-Allow-Headers", headers));
    }
    response.boxed()
}

#[derive(Serialize)]
struct FastifyBadUrl {
    error: &'static str,
    code: &'static str,
    message: String,
    #[serde(rename = "statusCode")]
    status_code: u16,
}

/// Malformed percent escapes are rejected by Fastify's URL parser before
/// route hooks run, so this response intentionally has no CORS, no-store, or
/// X-API-Version headers.
pub fn poi_bad_url(url: &str) -> ResponseBox {
    let body = serde_json::to_vec(&FastifyBadUrl {
        error: "Bad Request",
        code: "FST_ERR_BAD_URL",
        message: format!("'{url}' is not a valid url component"),
        status_code: 400,
    })
    .expect("Fastify bad-url response is serializable");
    Response::from_data(body)
        .with_status_code(400)
        .with_header(hdr("Content-Type", "application/json"))
        .boxed()
}

#[derive(Serialize)]
struct FastifyNotFound {
    message: String,
    error: &'static str,
    #[serde(rename = "statusCode")]
    status_code: u16,
}

/// Since Fastify 5.12 a capture longer than `maxParamLength` is rejected by
/// the router itself, like a malformed URL: a raw 414 with no CORS, no-store,
/// or X-API-Version headers.
pub fn poi_param_too_long(path: &str) -> ResponseBox {
    let body = serde_json::to_vec(&FastifyBadUrl {
        error: "Bad Request",
        code: "FST_ERR_MAX_PARAM_LENGTH",
        message: format!("'{path}' is exceeding the max param length"),
        status_code: 414,
    })
    .expect("Fastify max-param-length response is serializable");
    Response::from_data(body)
        .with_status_code(414)
        .with_header(hdr("Content-Type", "application/json"))
        .boxed()
}

/// Fastify's route-level 404, sent with normal global hooks.
pub fn poi_not_found(method: &str, url: &str, request: &Request) -> ResponseBox {
    let body = serde_json::to_vec(&FastifyNotFound {
        message: format!("Route {method}:{url} not found"),
        error: "Not Found",
        status_code: 404,
    })
    .expect("Fastify not-found response is serializable");
    let response = Response::from_data(body)
        .with_status_code(404)
        .with_header(hdr("Content-Type", "application/json; charset=utf-8"))
        .with_header(hdr("Cache-Control", "no-store"));
    let response = poi_response_headers()
        .into_iter()
        .fold(response, |response, header| response.with_header(header))
        .boxed();
    add_poi_cors(response, request)
}

/// Static-body error responses used by the dispatcher's reject paths.
pub fn not_found() -> ResponseBox {
    Response::from_data(b"{\"error\":\"not found\"}".to_vec())
        .with_status_code(404)
        .with_header(hdr("Content-Type", "application/json"))
        .boxed()
}

pub fn method_not_allowed() -> ResponseBox {
    Response::from_data(b"{\"error\":\"method not allowed\"}".to_vec())
        .with_status_code(405)
        .with_header(hdr("Content-Type", "application/json"))
        .boxed()
}

pub fn payload_too_large() -> ResponseBox {
    Response::from_data(b"{\"error\":\"request body too large\"}".to_vec())
        .with_status_code(413)
        .with_header(hdr("Content-Type", "application/json"))
        .boxed()
}

pub fn internal_error() -> ResponseBox {
    Response::from_data(b"{\"error\":\"internal server error\"}".to_vec())
        .with_status_code(500)
        .with_header(hdr("Content-Type", "application/json"))
        .boxed()
}

/// A tiny_http response wrapper around a [`Cursor<Vec<u8>>`] body — the type
/// used by handler unit tests. Not used by the production dispatcher.
pub type JsonResponse = Response<Cursor<Vec<u8>>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::response::{ByteBody, Resp};
    use std::sync::Arc;

    fn header_value(resp: &ResponseBox, name: &str) -> Option<String> {
        resp.headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str().to_string())
    }

    /// Spelled out rather than compared to the const — asserting a const
    /// against itself proves nothing. The SAME literal is pinned on the Node
    /// side (`packages/shared/src/types/scheduleTile.test.ts`), so a typo in
    /// either plane's constant fails that plane's own suite instead of waiting
    /// for the live route-parity gate to notice the two planes disagree.
    #[test]
    fn bundle_hash_header_is_the_wire_literal_both_planes_emit() {
        assert_eq!(BUNDLE_HASH_HEADER, "X-PT-Bundle-Hash");
    }

    #[test]
    fn with_headers_adds_headers_and_keeps_the_inner_response() {
        let inner = Resp::CachedBytes {
            status: 200,
            body: ByteBody::Raw(Arc::from(&b"{}"[..])),
            content_type: "application/json",
            cache_control: "no-cache",
            etag: Some("\"e\"".to_string()),
            gzipped: false,
        };
        let resp = to_tiny_http(Resp::WithHeaders {
            inner: Box::new(inner),
            headers: vec![("X-PT-Realtime", String::new()), ("X-Extra", "a, b".into())],
        });
        assert_eq!(resp.status_code().0, 200);
        assert_eq!(header_value(&resp, "ETag").as_deref(), Some("\"e\""));
        assert_eq!(header_value(&resp, "X-PT-Realtime").as_deref(), Some(""));
        assert_eq!(header_value(&resp, "X-Extra").as_deref(), Some("a, b"));
        let (_, body) = raw_response(resp, false);
        assert_eq!(body, b"{}");
    }

    fn raw_response(resp: ResponseBox, head: bool) -> (String, Vec<u8>) {
        let mut wire = Vec::new();
        resp.raw_print(&mut wire, tiny_http::HTTPVersion(1, 1), &[], head, None)
            .expect("serialize tiny_http response");
        let header_end = wire
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response has header terminator");
        let headers =
            String::from_utf8(wire[..header_end].to_vec()).expect("response headers are ASCII");
        (headers, wire[header_end + 4..].to_vec())
    }

    fn raw_header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
        headers.lines().skip(1).find_map(|line| {
            let (field, value) = line.split_once(':')?;
            field
                .eq_ignore_ascii_case(name)
                .then_some(value.trim_start())
        })
    }

    #[test]
    fn no_content_emits_204_with_no_type_no_body_and_no_chunking() {
        // Asserted on the actual wire bytes, because the obvious spelling —
        // Resp::Json { status: 204, body: String::new() } — goes through
        // Response::from_data and would add a JSON Content-Type to a response
        // that has no content.
        let (headers, body) = raw_response(to_tiny_http(Resp::NoContent), false);
        assert!(headers.starts_with("HTTP/1.1 204"), "{headers}");
        assert_eq!(
            raw_header_value(&headers, "Content-Type"),
            None,
            "{headers}"
        );
        assert!(body.is_empty(), "204 must carry no body, got {body:?}");
        // No chunked framing: 204 is one of the statuses tiny_http's
        // `choose_transfer_encoding` special-cases to Identity, so this does
        // NOT inherit the stray `Transfer-Encoding: chunked` that the 304 path
        // is documented as carrying.
        assert_eq!(
            raw_header_value(&headers, "Transfer-Encoding"),
            None,
            "{headers}"
        );
    }

    #[test]
    fn no_content_carries_content_length_zero_which_is_a_known_tiny_http_divergence() {
        // Pinned deliberately rather than left unasserted. RFC 7230 says
        // a server MUST NOT send Content-Length on a 204 and Fastify does not,
        // but tiny_http's Identity branch always writes one. If a future
        // tiny_http drops it, this test fails and the divergence note on the
        // `Resp::NoContent` arm should be deleted rather than the assertion
        // relaxed.
        let (headers, _) = raw_response(to_tiny_http(Resp::NoContent), false);
        assert_eq!(
            raw_header_value(&headers, "Content-Length"),
            Some("0"),
            "{headers}"
        );
    }

    #[test]
    fn cached_bytes_emits_exact_headers() {
        let body: Arc<[u8]> = Arc::from(b"{\"k\":1}".to_vec().into_boxed_slice());
        let resp = to_tiny_http(Resp::CachedBytes {
            status: 200,
            body: ByteBody::Raw(body),
            content_type: "application/json",
            cache_control: "public, max-age=3600",
            etag: None,
            gzipped: false,
        });
        assert_eq!(resp.status_code().0, 200);
        assert_eq!(
            header_value(&resp, "Content-Type").as_deref(),
            Some("application/json")
        );
        assert_eq!(
            header_value(&resp, "Cache-Control").as_deref(),
            Some("public, max-age=3600")
        );
        assert_eq!(header_value(&resp, "X-API-Version").as_deref(), Some("1"));
        assert!(header_value(&resp, "ETag").is_none(), "no ETag when None");
        assert!(
            header_value(&resp, "Content-Encoding").is_none(),
            "no gzip when false"
        );
    }

    /// A `Resp::Bytes` response (the `/raptor-bundle` arm) must stamp
    /// `X-Ptb-Version` with the live header version threaded from the byte
    /// handler — the operator-facing confirmation of the served format.
    /// Mirrors the `X-API-Version` assertion above.
    #[test]
    fn bytes_emits_x_ptb_version_header() {
        let body: Arc<[u8]> = Arc::from(b"\x50\x54\x42\x00".to_vec().into_boxed_slice());
        let resp = to_tiny_http(Resp::Bytes {
            body: ByteBody::Raw(body),
            etag: "\"abc\"".to_string(),
            gzipped: false,
            ptb_version: 6,
            provenance: None,
        });
        assert_eq!(resp.status_code().0, 200);
        assert_eq!(
            header_value(&resp, "X-Ptb-Version").as_deref(),
            Some("6"),
            "bundle response must carry the live PTB header version"
        );
        assert_eq!(header_value(&resp, "ETag").as_deref(), Some("\"abc\""));
    }

    #[test]
    fn with_bundle_hash_byte_success_emits_all_headers() {
        let body: Arc<[u8]> = Arc::from(b"brotli-bytes".to_vec().into_boxed_slice());
        let resp = to_tiny_http(Resp::WithBundleHash {
            status: 200,
            content_type: "application/octet-stream",
            cache_control: Some("public, max-age=31536000, immutable"),
            body: Some(ByteBody::Raw(body)),
            json_body: None,
            etag: Some("\"etag123\"".to_string()),
            bundle_hash: Some("hash123".to_string()),
            vary_accept_encoding: false,
        });
        assert_eq!(resp.status_code().0, 200);
        assert_eq!(
            header_value(&resp, "Content-Type").as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(
            header_value(&resp, "Cache-Control").as_deref(),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(header_value(&resp, "ETag").as_deref(), Some("\"etag123\""));
        assert_eq!(
            header_value(&resp, BUNDLE_HASH_HEADER).as_deref(),
            Some("hash123")
        );
    }

    #[test]
    fn with_bundle_hash_not_modified_has_empty_body_and_headers() {
        let resp = to_tiny_http(Resp::WithBundleHash {
            status: 304,
            content_type: "application/octet-stream",
            cache_control: None,
            body: None,
            json_body: None,
            etag: Some("\"etag123\"".to_string()),
            bundle_hash: Some("hash123".to_string()),
            vary_accept_encoding: false,
        });
        assert_eq!(resp.status_code().0, 304);
        assert!(header_value(&resp, "Cache-Control").is_none());
        assert_eq!(header_value(&resp, "ETag").as_deref(), Some("\"etag123\""));
        assert_eq!(
            header_value(&resp, BUNDLE_HASH_HEADER).as_deref(),
            Some("hash123")
        );
    }

    #[test]
    fn with_bundle_hash_json_error_carries_hash_header() {
        let resp = to_tiny_http(Resp::WithBundleHash {
            status: 409,
            content_type: "application/json",
            cache_control: None,
            body: None,
            json_body: Some(
                r#"{"error":"bundle_hash_mismatch","currentBundleHash":"h2"}"#.to_string(),
            ),
            etag: None,
            bundle_hash: Some("h2".to_string()),
            vary_accept_encoding: false,
        });
        assert_eq!(resp.status_code().0, 409);
        assert_eq!(
            header_value(&resp, "Content-Type").as_deref(),
            Some("application/json")
        );
        assert_eq!(
            header_value(&resp, BUNDLE_HASH_HEADER).as_deref(),
            Some("h2")
        );
        assert!(header_value(&resp, "ETag").is_none());
    }

    #[test]
    fn poi_tile_200_emits_attribution_content_encoding_and_no_bundle_hash() {
        let body: Arc<[u8]> = Arc::from(b"brotli-bytes".to_vec().into_boxed_slice());
        let resp = to_tiny_http(Resp::PoiTile {
            status: 200,
            content_type: "application/json",
            cache_control: Some("public, max-age=31536000, immutable"),
            body: Some(ByteBody::Raw(body)),
            json_body: None,
            etag: Some("\"etag123\"".to_string()),
            attribution: true,
        });
        assert_eq!(resp.status_code().0, 200);
        assert_eq!(
            header_value(&resp, "Content-Encoding").as_deref(),
            Some("br")
        );
        assert_eq!(
            header_value(&resp, "X-POI-Attribution").as_deref(),
            Some("(c) OpenStreetMap contributors")
        );
        assert_eq!(
            header_value(&resp, "X-POI-License").as_deref(),
            Some("https://opendatacommons.org/licenses/odbl/")
        );
        assert_eq!(
            header_value(&resp, "X-App-Version").as_deref(),
            Some(env!("PT_SERVE_APP_VERSION"))
        );
        assert_eq!(
            header_value(&resp, "X-App-Commit").as_deref(),
            Some(env!("PT_SERVE_GIT_SHA"))
        );
        assert_eq!(header_value(&resp, "X-API-Version").as_deref(), Some("1"));
        assert!(
            header_value(&resp, BUNDLE_HASH_HEADER).is_none(),
            "poi-tile carries no GTFS bundle-hash concept"
        );
        assert!(
            header_value(&resp, "Vary").is_none(),
            "Node's poiTile route never sets Vary"
        );
    }

    #[test]
    fn poi_tile_large_get_and_head_use_the_representation_content_length() {
        let body = vec![b'x'; 64 * 1024];

        for head in [false, true] {
            let resp = to_tiny_http(Resp::PoiTile {
                status: 200,
                content_type: "application/json",
                cache_control: Some("public, max-age=0, must-revalidate"),
                body: Some(ByteBody::Raw(Arc::from(body.clone().into_boxed_slice()))),
                json_body: None,
                etag: Some("\"etag123\"".to_string()),
                attribution: true,
            });
            let (headers, wire_body) = raw_response(resp, head);
            assert_eq!(
                raw_header_value(&headers, "Content-Length"),
                Some(body.len().to_string().as_str())
            );
            assert!(
                raw_header_value(&headers, "Transfer-Encoding").is_none(),
                "bounded POI responses must not switch to chunked framing"
            );
            if head {
                assert!(wire_body.is_empty(), "HEAD must suppress the entity bytes");
            } else {
                assert_eq!(wire_body, body, "GET must send the complete entity");
            }
        }
    }

    #[test]
    fn poi_tile_304_carries_attribution_but_no_content_encoding() {
        let resp = to_tiny_http(Resp::PoiTile {
            status: 304,
            content_type: "application/json",
            cache_control: Some("public, max-age=31536000, immutable"),
            body: None,
            json_body: None,
            etag: Some("\"etag123\"".to_string()),
            attribution: true,
        });
        assert_eq!(resp.status_code().0, 304);
        assert!(header_value(&resp, "Content-Encoding").is_none());
        assert!(header_value(&resp, "Content-Type").is_none());
        assert_eq!(
            header_value(&resp, "X-POI-Attribution").as_deref(),
            Some("(c) OpenStreetMap contributors")
        );
    }

    #[test]
    fn poi_tile_304_raw_headers_omit_fastify_content_metadata() {
        let resp = to_tiny_http(Resp::PoiTile {
            status: 304,
            content_type: "application/json",
            cache_control: Some("public, max-age=0, must-revalidate"),
            body: None,
            json_body: None,
            etag: Some("\"etag123\"".to_string()),
            attribution: true,
        });
        let (headers, body) = raw_response(resp, false);
        assert_eq!(raw_header_value(&headers, "ETag"), Some("\"etag123\""));
        assert!(raw_header_value(&headers, "Content-Type").is_none());
        assert!(raw_header_value(&headers, "Content-Length").is_none());
        assert!(raw_header_value(&headers, "Content-Encoding").is_none());
        // PINS a known divergence rather than asserting the ideal. tiny_http
        // selects Chunked for any None-length response outside 1xx/204, so this
        // 304 advertises `Transfer-Encoding: chunked` where Fastify sends neither
        // that nor Content-Length. See the 304 arm in `to_tiny_http` for why
        // neither `with_chunked_threshold` nor `data_length: Some(0)` fixes it.
        // If this assertion ever fails, tiny_http changed behaviour and the
        // divergence comment above should be revisited.
        assert_eq!(
            raw_header_value(&headers, "Transfer-Encoding"),
            Some("chunked"),
            "304 framing changed; re-check the tiny_http divergence note"
        );
        assert!(
            body.is_empty(),
            "304 must not emit entity bytes, chunked framing notwithstanding"
        );
    }

    #[test]
    fn poi_tile_error_carries_no_attribution() {
        let resp = to_tiny_http(Resp::PoiTile {
            status: 404,
            content_type: "application/json",
            cache_control: None,
            body: None,
            json_body: Some(r#"{"error":{"code":"UNKNOWN_CITY"}}"#.to_string()),
            etag: None,
            attribution: false,
        });
        assert_eq!(resp.status_code().0, 404);
        assert!(header_value(&resp, "X-POI-Attribution").is_none());
        assert!(header_value(&resp, "X-POI-License").is_none());
    }

    #[test]
    fn with_bundle_hash_omits_header_when_none() {
        let resp = to_tiny_http(Resp::WithBundleHash {
            status: 400,
            content_type: "application/json",
            cache_control: None,
            body: None,
            json_body: Some(r#"{"error":{"code":"INVALID_BUNDLE_HASH"}}"#.to_string()),
            etag: None,
            bundle_hash: None,
            vary_accept_encoding: false,
        });
        assert_eq!(resp.status_code().0, 400);
        assert!(
            header_value(&resp, BUNDLE_HASH_HEADER).is_none(),
            "400s fire before a hash is known"
        );
    }
}
