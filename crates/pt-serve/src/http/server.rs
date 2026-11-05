//! Top-level request dispatcher — the only place outside `http::adapter` that
//! touches `tiny_http`. Loads the active generation from the swap handle once
//! per request, then hands a borrowed `&Generation` down through the app
//! handlers.

use crate::app::query::decode_form_component;
use crate::app::{
    address_search as app_address_search, bytes as app_bytes, client_report as app_client_report,
    color_config as app_color_config, departures_for_stop as app_departures_for_stop,
    gtfs_manifest as app_gtfs_manifest, metrics as app_metrics, plan as app_plan,
    poi_tile as app_poi_tile, route_rt as app_route_rt, rt_health as app_rt_health,
    rt_tile as app_rt_tile, schedule_tile as app_schedule_tile,
    scheduled_departures as app_scheduled, shapes as app_shapes, stops as app_stops,
    version as app_version,
};
use crate::http::adapter::{
    self, accepts_gzip, if_generation_match, if_none_match, internal_error, method_not_allowed,
    not_found, payload_too_large,
};
use crate::ops::{Metrics, ServerCtx, TimeoutRegistry};
use crate::poi::catalog::{
    city_id_valid, classify_poi_city_for_metrics, UNKNOWN_POI_CITY_METRIC_LABEL,
};
use crate::router::{resolve, ListenerKind, Route};
use pt_core::ScanState;
use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use tiny_http::{Request, Server};

/// Hard cap on the `/plan` request body. A client can otherwise stream an arbitrarily large POST
/// and force a per-worker allocation proportional to the body size — a memory-DoS against a process
/// whose whole point is a small, bounded resident set. Realistic /plan bodies are 1–10 KiB
/// (entry+exit stop ids + a few flags); 32 KiB is generous headroom and well below any plausible
/// DoS threshold.
///
/// **MUST equal `client_max_body_size` in `nginx/city-proxies.inc` for the `location =
/// /api/<city>/plan` block.** Mismatched caps produce a confusing failure mode: nginx returns 413
/// for bodies in (nginx_cap, server_cap] while pt-serve would accept them, or vice-versa.
const MAX_PLAN_BODY_BYTES: u64 = 32 * 1024;

/// Fixed scratch buffer for `drain_body`. Constant size — the whole point is to
/// consume the unread remainder of an over-cap body WITHOUT an allocation
/// proportional to that remainder.
const DRAIN_CHUNK_BYTES: usize = 8 * 1024;

/// Bind a tiny_http listener and return the shared server handle. Lives here so
/// `main.rs` (and any future spawn-from-library callers) does not need to
/// import `tiny_http` directly.
pub fn bind(listen: &str) -> std::io::Result<Arc<Server>> {
    Server::http(listen)
        .map(Arc::new)
        .map_err(|e| std::io::Error::other(format!("{e}")))
}

/// Extract the query string (the `?...` tail) from a request URL. Returns the
/// portion AFTER the first `?` (empty when there is none). The C2c
/// `/scheduled-departures-for-stop` handler parses its params out of this.
fn query_of(url: &str) -> &str {
    match url.split_once('?') {
        Some((_, q)) => q,
        None => "",
    }
}

const MAX_POI_VERSION_BYTES: usize = 64;

/// Match Fastify's scalar query semantics for the generation pin. Form
/// encoding is decoded (`+` and `%HH`), while duplicate keys become an array
/// in Fastify and therefore cannot equal the advertised SHA. Any duplicate or
/// malformed matching value becomes an empty scalar, which deterministically
/// takes the same 409 branch without retaining attacker-sized input.
fn query_param(query: &str, key: &str) -> Option<String> {
    let mut found = None;
    for pair in query.split('&') {
        let (raw_name, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let Ok(name) = decode_form_component(raw_name, key.len()) else {
            continue;
        };
        if name != key {
            continue;
        }
        if found.is_some() {
            return Some(String::new());
        }
        found = Some(
            decode_form_component(raw_value, MAX_POI_VERSION_BYTES)
                .unwrap_or_else(|_| String::new()),
        );
    }
    found
}

/// Consume and discard whatever is left of the request body, in fixed-size
/// chunks, so that `tiny_http`'s `EqualReader::drop` finds nothing left to read.
/// (See deleted `lib::drain_body` for full rationale.)
fn drain_body(req: &mut Request) {
    let mut sink = [0u8; DRAIN_CHUNK_BYTES];
    let reader = req.as_reader();
    loop {
        match reader.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

/// Map a handler `Resp` to a bounded status label for `pt_serve_requests_total`.
fn status_label(resp: &crate::app::response::Resp) -> &'static str {
    use crate::app::response::Resp;
    match resp {
        Resp::CachedBytes { status, .. }
        | Resp::Json { status, .. }
        | Resp::WithBundleHash { status, .. }
        | Resp::PoiTile { status, .. } => match status {
            200 => "200",
            304 => "304",
            // 400 + 412 are returned by the scheduled-departures arm
            // (bad-request / generation-mismatch); keep them distinct so the
            // per-route counter can attribute them.
            400 => "400",
            404 => "404",
            // 409 is returned by the schedule-tile arm (bundle_hash_mismatch
            // / bundle_unavailable) — same "keep distinct" reasoning as 400/412.
            409 => "409",
            412 => "412",
            500 => "500",
            503 => "503",
            _ => "other",
        },
        Resp::NotModified { .. } => "304",
        Resp::NotFoundEmpty => "404",
        Resp::NoContent => "204",
        Resp::Bytes { .. } | Resp::Prometheus { .. } => "200",
    }
}

fn inc_poi_tile_request_metric(ctx: &ServerCtx, city_id: &str, status: &'static str) {
    ctx.metrics
        .inc_poi_tile_request(&classified_poi_city(ctx, city_id), status);
}

/// The bounded metric label for `city_id`: one of the at-most-four strict
/// manifest cities, or `unknown`. Shared by the request counter here and the
/// shed counter in the POI handler so the bound is enforced in ONE place —
/// `classify_poi_city_for_metrics` is the only thing keeping this label set
/// from echoing untrusted URL input.
pub(crate) fn classified_poi_city(ctx: &ServerCtx, city_id: &str) -> String {
    if !city_id_valid(city_id) {
        return UNKNOWN_POI_CITY_METRIC_LABEL.to_owned();
    }
    ctx.poi_manifest_cache
        .get_or_load(&ctx.config)
        .ok()
        .flatten()
        .map(|ready| {
            classify_poi_city_for_metrics(&ready.manifest, city_id)
                .label()
                .to_owned()
        })
        .unwrap_or_else(|| UNKNOWN_POI_CITY_METRIC_LABEL.to_owned())
}

/// Top-level dispatcher — called once per request by each worker thread.
///
/// Loads the active generation via `ctx.gen_handle.load_full()` (an
/// `Arc<Generation>` whose refcount lives ONLY on this stack frame, so a
/// concurrent swap drops the old generation as soon as in-flight requests
/// return — no leak across reloads). Per-worker scratch `Option<ScanState>` is
/// re-allocated by the plan handler on epoch mismatch.
///
/// Carry-forward fix (from the original `dispatch`): the handler call is
/// wrapped in `catch_unwind` so a panic returns 500 instead of killing the
/// worker thread.
///
/// when `timeout_registry` is `Some`, the dispatcher registers a slot for the request and, on
/// handler return, checks the slot's `timed_out` flag. If set, the `tiny_http::Request` is dropped
/// WITHOUT a `respond()` call so tiny_http's internal `RefinedTcpStream::Drop` closes the
/// connection. The slot's RAII guard ([`crate::ops::TimeoutTicket`]) unregisters from the watchdog
/// on Drop so a fast request never lingers in the registry.
pub fn dispatch(
    ctx: &ServerCtx,
    scan_state: &mut Option<ScanState>,
    mut req: Request,
    timeout_registry: Option<&Arc<TimeoutRegistry>>,
    listener: ListenerKind,
) {
    // The dec MUST observe every inc; a leaked gauge would make the drain-timeout logic stall
    // waiting for phantom requests. The guard records WHICH gauge it bumped so the matching dec
    // fires on Drop.
    struct InflightGuard<'a>(&'a Metrics, ListenerKind);
    impl Drop for InflightGuard<'_> {
        fn drop(&mut self) {
            match self.1 {
                ListenerKind::Public | ListenerKind::Auxiliary => self.0.dec_inflight_requests(),
                ListenerKind::Loopback => self.0.dec_loopback_inflight(),
            }
        }
    }
    match listener {
        ListenerKind::Public | ListenerKind::Auxiliary => {
            ctx.metrics.inc_inflight_requests();
        }
        ListenerKind::Loopback => ctx.metrics.inc_loopback_inflight(),
    }
    let _inflight = InflightGuard(&ctx.metrics, listener);

    // register this request with the watchdog if one is wired in. `ticket` is `None` for the
    // in-process tests that drive `dispatch` without a watchdog (e.g. tests/server.rs in the P3-era
    // harness).
    let ticket = timeout_registry.map(|r| r.register());

    let gen = ctx.current_generation();

    // Resolve route using &str borrows; the block scope ensures the borrows
    // end before any &mut req usage below.
    let route = {
        let method = req.method().as_str();
        let url = req.url();
        resolve(method, url, &gen.city_slug, listener)
    };

    // For the two POST arms, read body now (after route borrows dropped). For
    // all other arms, body is never read. The two-layer body cap mirrors the
    // deleted `lib::dispatch`.
    //
    // Each POST route carries its OWN cap: 32 KiB for a plan payload, 1 KiB for
    // a client report (Node's `bodyLimit` on that route). Sharing the plan cap
    // would let a client-report POST buy 32x the buffer it can ever need.
    // Only `plan` increments the oversize counters — they are named for it and
    // feed the plan-specific budget panels.
    let body_cap: Option<u64> = match route {
        Route::Plan => Some(MAX_PLAN_BODY_BYTES),
        Route::ClientReport => Some(app_client_report::MAX_CLIENT_REPORT_BODY_BYTES),
        _ => None,
    };
    let body: Vec<u8> = if let Some(cap) = body_cap {
        let is_plan = matches!(route, Route::Plan);
        if is_plan {
            ctx.metrics.inc_plan_requests();
        }
        if matches!(req.body_length(), Some(len) if len as u64 > cap) {
            if is_plan {
                ctx.metrics.inc_oversized_plan_requests();
            }
            drain_body(&mut req);
            if req.respond(payload_too_large()).is_err() {
                ctx.metrics.inc_response_write_failures();
            }
            return;
        }
        let mut b = Vec::new();
        let _ = req.as_reader().take(cap + 1).read_to_end(&mut b);
        if b.len() as u64 > cap {
            if is_plan {
                ctx.metrics.inc_oversized_plan_requests();
            }
            drain_body(&mut req);
            if req.respond(payload_too_large()).is_err() {
                ctx.metrics.inc_response_write_failures();
            }
            return;
        }
        b
    } else {
        Vec::new()
    };

    let resp: tiny_http::ResponseBox = std::panic::catch_unwind(AssertUnwindSafe(|| match route {
        Route::Health => adapter::to_tiny_http(app_version::health()),
        Route::RtHealth => adapter::to_tiny_http(app_rt_health::rt_health(ctx)),
        Route::Ready => adapter::to_tiny_http(app_version::ready(&gen, ctx)),
        Route::Version => adapter::to_tiny_http(app_version::version(&gen, ctx)),
        Route::Metrics => adapter::to_tiny_http(app_metrics::metrics_resp(&ctx.metrics)),
        Route::RouteRt(ref route_id) => {
            let resp = app_route_rt::route_rt(route_id, &gen, ctx, &pt_shared::clock::SystemClock);
            ctx.metrics.inc_request("route-rt", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::ClientReport => {
            let resp = app_client_report::client_report(&body, &ctx.metrics);
            ctx.metrics
                .inc_request("client-report", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::Plan => {
            // Thread the watchdog's timed_out flag into the engine so a
            // CPU-bound scan aborts at the next round boundary instead of
            // pinning this worker past the request timeout (the post-handler
            // check below can only drop the response, not reclaim the CPU).
            let timed_out = ticket.as_ref().map(|t| t.timed_out_flag());
            adapter::to_tiny_http(app_plan::plan(
                &body,
                &gen,
                scan_state,
                ctx,
                timed_out.as_deref(),
            ))
        }
        Route::RaptorBundle => adapter::to_tiny_http(app_bytes::raptor_bundle(
            &gen,
            if_none_match(&req).as_deref(),
            accepts_gzip(&req),
            &gen.city_slug,
        )),
        Route::TransfersFetch => adapter::to_tiny_http(app_bytes::transfers_fetch(
            &gen,
            if_none_match(&req).as_deref(),
            accepts_gzip(&req),
        )),
        Route::RouteGeometryFetch => adapter::to_tiny_http(app_bytes::route_geometry_fetch(
            &gen,
            if_none_match(&req).as_deref(),
            accepts_gzip(&req),
        )),
        Route::AddressSearch => {
            let resp = app_address_search::search(query_of(req.url()), &gen);
            ctx.metrics
                .inc_request("address-search", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::AddressSearchManifest => {
            let resp = app_address_search::manifest(&gen, if_none_match(&req).as_deref());
            ctx.metrics
                .inc_request("address-search-manifest", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::AddressSearchBundle => {
            let resp = app_address_search::bundle(
                &gen,
                if_none_match(&req).as_deref(),
                accepts_gzip(&req),
            );
            ctx.metrics
                .inc_request("address-search-bundle", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        // the correctness keystone. Loopback-only (the router 404s it on the public listeners). The
        // handler is bounded by its 6h window clamp + maxResults + the ≤3-date candidate range, so
        // it is safe under the loopback pool's no-watchdog regime.
        Route::ScheduledDeparturesForStop => {
            let igm = if_generation_match(&req);
            let resp =
                app_scheduled::scheduled_departures(query_of(req.url()), &gen, ctx, igm.as_deref());
            // Per-route observability — mirrors the ColorConfig/Shapes arms so
            // 200/400/404/412/503 land in pt_serve_requests_total{route,status}.
            ctx.metrics
                .inc_request("scheduled-departures-for-stop", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::DeparturesForStop => {
            let igm = if_generation_match(&req);
            // Same rationale as Route::Plan above: the candidate scan is
            // CPU-bound and unbounded by request params, so it must abort at
            // the watchdog flag rather than pin this worker — the pool is
            // shared with /plan.
            let timed_out = ticket.as_ref().map(|t| t.timed_out_flag());
            let resp = app_departures_for_stop::departures_for_stop(
                query_of(req.url()),
                &gen,
                ctx,
                igm.as_deref(),
                timed_out.as_deref(),
            );
            ctx.metrics
                .inc_request("departures-for-stop", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        #[cfg(feature = "test-park")]
        Route::TestPark => {
            // Cooperatively park until the watchdog flips `timed_out` or
            // a hard ceiling fires. The ceiling prevents a runaway test
            // from hanging cargo's harness on a missing watchdog.
            let timed_out = ticket
                .as_ref()
                .map(|t| t.timed_out_flag())
                .unwrap_or_else(|| Arc::new(std::sync::atomic::AtomicBool::new(false)));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while !timed_out.load(std::sync::atomic::Ordering::SeqCst)
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            adapter::to_tiny_http(app_version::health())
        }
        Route::ColorConfig => {
            let resp = app_color_config::color_config(&gen);
            ctx.metrics.inc_request("color-config", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::StopsAll => {
            let resp = app_stops::stops_all(query_of(req.url()), &gen);
            ctx.metrics.inc_request("stops-all", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::StopsNearby => {
            let resp = app_stops::stops_nearby(query_of(req.url()), &gen);
            ctx.metrics.inc_request("stops-nearby", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::Shapes(ref artifact) => {
            let resp = app_shapes::shapes(
                &gen,
                artifact,
                if_none_match(&req).as_deref(),
                accepts_gzip(&req),
            );
            ctx.metrics.inc_request("shapes", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::GtfsManifest => {
            let resp = app_gtfs_manifest::gtfs_manifest(&gen, if_none_match(&req).as_deref());
            ctx.metrics
                .inc_request("gtfs-manifest", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::ScheduleTile(ref hash, ref size, ref coords) => {
            let resp = app_schedule_tile::schedule_tile(
                ctx,
                &gen,
                hash,
                size,
                coords,
                if_none_match(&req).as_deref(),
            );
            ctx.metrics
                .inc_request("schedule-tile", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::RtTile(ref hash, ref size, ref coords) => {
            let resp = app_rt_tile::rt_tile(
                ctx,
                &gen,
                &pt_shared::clock::SystemClock,
                hash,
                size,
                coords,
            );
            ctx.metrics.inc_request("rt-tile", status_label(&resp));
            adapter::to_tiny_http(resp)
        }
        Route::PoiTile(ref city_id, ref size, ref coords) => {
            let requested_version = query_param(query_of(req.url()), "v");
            let resp = app_poi_tile::poi_tile_with_version(
                ctx,
                city_id,
                size,
                coords,
                requested_version.as_deref(),
                if_none_match(&req).as_deref(),
            );
            inc_poi_tile_request_metric(ctx, city_id, status_label(&resp));
            adapter::to_tiny_http_poi(resp, &req)
        }
        Route::PoiTileOptions => adapter::poi_preflight(&req),
        Route::PoiTileBadUrl(ref url) => adapter::poi_bad_url(url),
        Route::PoiTileParamTooLong(ref path) => adapter::poi_param_too_long(path),
        Route::PoiTileNotFound {
            ref method,
            ref url,
        } => adapter::poi_not_found(method, url, &req),
        Route::WrongCity | Route::NotFound => not_found(),
        Route::MethodNotAllowed => method_not_allowed(),
    }))
    .unwrap_or_else(|_| internal_error());

    // if the watchdog timed this request out, drop the Request without calling respond().
    // tiny_http's `RefinedTcpStream::Drop` then closes the underlying socket via
    // shutdown(Read|Write). The default happy path (no timeout) sends the response normally.
    if let Some(t) = ticket.as_ref() {
        if t.timed_out() {
            // Dropping `req` here (via the function return) triggers
            // tiny_http's `Request::Drop`, which sends an empty 500 if a
            // response hasn't been written yet. That write may itself
            // block on a saturated TCP buffer in a slow-reader scenario;
            // the watchdog already incremented the counter and the
            // worker WILL eventually exit when the client gives up.
            // Skip the explicit respond; let Drop take over.
            return;
        }
    }
    if req.respond(resp).is_err() {
        ctx.metrics.inc_response_write_failures();
    }
}

#[cfg(test)]
mod tests {
    use super::{query_param, status_label};
    use crate::app::response::{ByteBody, Resp};
    use std::sync::Arc;

    fn raw_body() -> ByteBody {
        ByteBody::Raw(Arc::from(b"x".as_ref()))
    }

    #[test]
    fn query_param_extracts_exact_scalar() {
        assert_eq!(query_param("x=1&v=abc&z=2", "v").as_deref(), Some("abc"));
        assert_eq!(query_param("v=", "v").as_deref(), Some(""));
        assert_eq!(query_param("version=abc", "v"), None);
        assert_eq!(query_param("", "v"), None);
        assert_eq!(query_param("%76=%61bc", "v").as_deref(), Some("abc"));
        assert_eq!(query_param("v=a+b", "v").as_deref(), Some("a b"));
        assert_eq!(query_param("v=abc&v=abc", "v").as_deref(), Some(""));
        assert_eq!(query_param("v=%GG", "v").as_deref(), Some(""));
    }

    #[test]
    fn status_label_cached_bytes_200() {
        let r = Resp::CachedBytes {
            status: 200,
            body: raw_body(),
            content_type: "application/json",
            cache_control: "no-cache",
            etag: None,
            gzipped: false,
        };
        assert_eq!(status_label(&r), "200");
    }

    #[test]
    fn status_label_cached_bytes_304() {
        let r = Resp::CachedBytes {
            status: 304,
            body: raw_body(),
            content_type: "application/json",
            cache_control: "no-cache",
            etag: None,
            gzipped: false,
        };
        assert_eq!(status_label(&r), "304");
    }

    #[test]
    fn status_label_cached_bytes_503() {
        let r = Resp::CachedBytes {
            status: 503,
            body: raw_body(),
            content_type: "application/json",
            cache_control: "no-cache",
            etag: None,
            gzipped: false,
        };
        assert_eq!(status_label(&r), "503");
    }

    #[test]
    fn status_label_cached_bytes_other() {
        let r = Resp::CachedBytes {
            status: 429,
            body: raw_body(),
            content_type: "application/json",
            cache_control: "no-cache",
            etag: None,
            gzipped: false,
        };
        assert_eq!(status_label(&r), "other");
    }

    #[test]
    fn status_label_json_200() {
        let r = Resp::Json {
            status: 200,
            body: "{}".to_string(),
        };
        assert_eq!(status_label(&r), "200");
    }

    #[test]
    fn status_label_json_404() {
        let r = Resp::Json {
            status: 404,
            body: "{}".to_string(),
        };
        assert_eq!(status_label(&r), "404");
    }

    #[test]
    fn status_label_json_400() {
        let r = Resp::Json {
            status: 400,
            body: "{}".to_string(),
        };
        assert_eq!(status_label(&r), "400");
    }

    #[test]
    fn status_label_json_412() {
        let r = Resp::Json {
            status: 412,
            body: "{}".to_string(),
        };
        assert_eq!(status_label(&r), "412");
    }

    #[test]
    fn status_label_json_503() {
        let r = Resp::Json {
            status: 503,
            body: "{}".to_string(),
        };
        assert_eq!(status_label(&r), "503");
    }

    #[test]
    fn status_label_json_500() {
        let r = Resp::Json {
            status: 500,
            body: "{}".to_string(),
        };
        assert_eq!(status_label(&r), "500");
    }

    #[test]
    fn status_label_with_bundle_hash_200() {
        let r = Resp::WithBundleHash {
            status: 200,
            content_type: "application/octet-stream",
            cache_control: None,
            body: None,
            json_body: None,
            etag: None,
            bundle_hash: None,
            vary_accept_encoding: false,
        };
        assert_eq!(status_label(&r), "200");
    }

    #[test]
    fn status_label_with_bundle_hash_409() {
        let r = Resp::WithBundleHash {
            status: 409,
            content_type: "application/json",
            cache_control: None,
            body: None,
            json_body: None,
            etag: None,
            bundle_hash: None,
            vary_accept_encoding: false,
        };
        assert_eq!(status_label(&r), "409");
    }

    #[test]
    fn status_label_not_modified() {
        let r = Resp::NotModified {
            etag: "\"abc\"".to_string(),
            provenance: None,
        };
        assert_eq!(status_label(&r), "304");
    }

    #[test]
    fn status_label_not_found_empty() {
        assert_eq!(status_label(&Resp::NotFoundEmpty), "404");
    }

    #[test]
    fn status_label_bytes() {
        let r = Resp::Bytes {
            body: raw_body(),
            etag: "\"x\"".to_string(),
            gzipped: false,
            ptb_version: 6,
            provenance: None,
        };
        assert_eq!(status_label(&r), "200");
    }

    #[test]
    fn status_label_prometheus() {
        let r = Resp::Prometheus {
            body: "# metrics".to_string(),
        };
        assert_eq!(status_label(&r), "200");
    }
}
