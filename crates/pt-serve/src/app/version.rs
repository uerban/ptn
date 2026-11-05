//! `/health`, `/ready`, `/version` — JSON status endpoints (no `tiny_http`).
//!
//!
//! ## /ready body schema
//!
//! Even though the endpoint always returns 200 normally and 503 during
//! drain, the JSON body carries the readiness telemetry operators consult
//! when something looks off:
//!
//! ```json
//! {
//!   "status":                       "ready" | "draining",
//!   "city":                         "vilnius",
//!   "servingGenerationId":          "<hex>",
//!   "servingBundleSha256":          "<hex>",
//!   "servingLastGoodFallback":      false,
//!   "reloadConsecutiveFailures":    0,
//!   "lastSuccessfulReloadAt":       "2026-05-23T12:00:00Z" | null,
//!   "manifestSchemaVersionMax":     1,
//!   "generationAgeSecs":            120,
//!   "feedStartDate":                20260501,
//!   "feedStartDateAgeDays":         22,
//!   "feedWindowStale":              false,
//!   "lastGoodAgeExceedsRetention":  false,
//!   "forcedCurrentMode":            false,
//!   "departuresIdxPresent":         true,
//!   "boardingRegionPresent":        true,
//!   "windowDays":                   90,
//!   "windowMetaRegionPresent":      false,
//!   "serviceBitfieldPoolCount":     2 | null,
//!   "cityTzIana":                   "Europe/Vilnius" | null,
//!   "servingShapesJsonSha256":      "<hex>" | null,
//!   "servingShapesJsonSizeBytes":   12345 | null,
//!   "nowUnixSecs":                  1748001600,
//!   "patternMode":                  "off" | "unbounded" | "covering-merge",
//!   "poiTile": {
//!     "configured":                 true,
//!     "ready":                      false,
//!     "error":                      "invalid POI manifest" | null
//!   }
//! }
//! ```
//!
//! `departuresIdxPresent` (DPIX sidecar mmapped) and `cityTzIana` (resolved
//! city zone, `null` when unresolved) are C2c degraded-state signals: a
//! generation can load cleanly yet hard-503 the loopback
//! `/scheduled-departures-for-stop` route when either is missing.
//!
//! `boardingRegionPresent` is `true` when boarding predicates are present in
//! EITHER `0x12 PatternSemantics` (the published, carry-less bundle) OR `0xFA
//! StopTimeBoarding` (a staging bundle that still carries the flat timetable),
//! so this covers BOTH region homes. The A1 pickup/drop-off
//! predicate is always-on, but `false` means every stop_time defaults to `0x50`
//! (regular pickup + drop-off) / `SEMANTICS_REGULAR` — i.e. the producer found no
//! `pickup_type=1`/`drop_off_type=1` rows to carry for this city. Because the PTB
//! version field cannot signal which region (or whether either) is present,
//! ops/manual-QA use this flag to confirm the predicate has data to act on.
//!
//! `windowDays` reports the RUNTIME service-bitmask window length of the loaded
//! bundle (default 90 when the `0x01 WindowMeta` region is absent), and
//! `windowMetaRegionPresent` is the authoritative provenance bit. The pair lets
//! an operator distinguish a DECODED window from the absent-region default:
//! `windowMetaRegionPresent == false` with `windowDays == 90` is the default
//! path (any feed whose derived window is 90 — the producer omits the region
//! at the default), whereas
//! `windowMetaRegionPresent == true` means a non-default window was explicitly
//! decoded. Because the PTB version stays the same whether or not the region is
//! present, `/version` cannot signal it. (The clamp/floor counts — how many
//! services were floored/clamped to fit the window — live in `generation.json`,
//! which is the system of record and is NOT threaded into `/ready`.)
//!
//! `serviceBitfieldPoolCount` reports the distinct-bitfield `count` from the
//! `0x15 ServiceBitfieldPool` region (the B2 de-duplicated service-bitfield
//! storage), so operators can confirm the de-dup decoded for this generation
//! (and watch dedup ratio = `numServices : serviceBitfieldPoolCount`).
//!
//! `forcedCurrentMode` is `true` for the entire process lifetime when
//! `--force-current` was supplied at startup. Operators clear it by
//! restarting WITHOUT the flag AND re-publishing (so `current.json` is
//! authoritative again). Mirrors the `pt_serve_forced_current_mode`
//! Prometheus gauge.
//!
//! All fields are best-effort: a malformed `created_at` on the live
//! generation yields `null` for `generationAgeSecs`; a missing
//! `reload_last_success_timestamp_seconds` (no reload has ever succeeded)
//! yields `null` for `lastSuccessfulReloadAt`. The 503 drain body retains
//! `status: "draining"` + `city` and OMITS the readiness telemetry — the
//! drain state is binary; the gauges are stale by definition while a swap
//! could be in flight.

use crate::app::response::Resp;
use crate::bundle::Generation;
use crate::ops::readiness::{
    days_between_ymd, format_rfc3339_utc, parse_rfc3339_utc, ymd_utc, FEED_STALE_DAYS,
};
use crate::ops::ServerCtx;
use pt_shared::manifest::MANIFEST_SCHEMA_VERSION_MAX;

fn json_response(status: u16, body: String) -> Resp {
    Resp::Json { status, body }
}

pub fn health() -> Resp {
    json_response(200, r#"{"status":"ok"}"#.to_string())
}

/// `/ready` body — see module docs for the schema.
pub fn ready(gen: &Generation, ctx: &ServerCtx) -> Resp {
    // 503 (drain): the body remains a stable minimal shape — telemetry is
    // intentionally omitted because workers may be mid-swap.
    if ctx.metrics.ready_503() {
        return json_response(
            503,
            format!(
                r#"{{"status":"draining","city":{}}}"#,
                json_string(&gen.city_slug)
            ),
        );
    }

    // 200 (normal): full readiness body.
    let now = std::time::SystemTime::now();
    let now_unix_secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let now_ymd_value = ymd_utc(now);

    // generationAgeSecs: parse the manifest createdAt and subtract. A
    // missing/malformed timestamp renders as `null` so monitoring can
    // alert on the parse failure separately.
    let generation_age_secs_json: String = if gen.created_at.is_empty() {
        // P3 baseline `Generation::from_paths` leaves this empty. Render
        // null rather than 0 so dashboards distinguish "process built
        // without manifest" from "fresh adoption".
        "null".to_string()
    } else {
        match parse_rfc3339_utc(&gen.created_at) {
            Some(t) => {
                let age = now.duration_since(t).map(|d| d.as_secs()).unwrap_or(0);
                age.to_string()
            }
            None => "null".to_string(),
        }
    };

    // lastSuccessfulReloadAt: 0 means "no reload has ever succeeded"
    // (counter is initialised to 0; the runner sets it on first adopt).
    // Render that as null so dashboards distinguish "process just
    // started" from "process at unix epoch".
    let last_success_ts = ctx.metrics.reload_last_success_timestamp_seconds();
    let last_successful_reload_at_json: String = if last_success_ts == 0 {
        "null".to_string()
    } else {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(last_success_ts);
        json_string(&format_rfc3339_utc(t))
    };

    // feedStartDate may be 0 only for the P3 baseline `from_paths` path
    // (the PTB always carries one in P4); render 0 as such — operators
    // see the literal value and can act on it.
    let feed_start_date = gen.feed_start_date;
    let feed_age_days = if feed_start_date == 0 {
        0
    } else {
        days_between_ymd(feed_start_date, now_ymd_value)
    };
    let feed_window_stale =
        feed_start_date != 0 && feed_age_days > u64::from(ctx.config.feed_stale_days);
    // Sanity: the operator-configurable threshold defaults to
    // FEED_STALE_DAYS; the constant is the cross-language source of
    // truth, but the runtime value comes from config so a DR override
    // (PT_SERVE_FEED_STALE_DAYS) is honoured.
    let _ = FEED_STALE_DAYS;

    let last_good_age_exceeds_retention = ctx.metrics.last_good_age_exceeds_retention_total() > 0;

    // C2c degraded-state signals: a generation can LOAD cleanly yet hard-503
    // the loopback `/scheduled-departures-for-stop` route when its DPIX sidecar
    // is absent or its city tz is unresolved. Surface both so operators can
    // distinguish "process unhealthy" from "loopback route degraded".
    let departures_idx_present = gen.departures_idx_mmap.is_some();
    // A1 pickup/drop-off: `true` when boarding predicates are PRESENT in EITHER
    // 0x12 PatternSemantics (the published, carry-less bundle) OR 0xFA
    // StopTimeBoarding (a staging bundle), so cover BOTH — a bare `has_boarding()`
    // reads only 0xFA and would report `false` on a published bundle that DOES
    // carry non-regular boarding in 0x12. `false` ⇒ neither region is
    // present (every stop_time defaults to 0x50 / SEMANTICS_REGULAR). The predicate
    // is always-on; this only reports whether there is non-default data to act on.
    let boarding_region_present = gen.reader.has_boarding() || gen.reader.has_pattern_semantics();
    // `true` when the bundle carries a `0x17 Frequencies` region,
    // meaning the feed had a `frequencies.txt` with at least one row; `false`
    // for bundles built from feeds without `frequencies.txt`. Carry-only (no scan uses it
    // yet); the flag lets operators confirm the region was decoded.
    let frequencies_region_present = gen.reader.has_frequencies();
    // windowDays Step A provenance: the RUNTIME service-bitmask window length
    // (default 90 when the `0x01 WindowMeta` region is absent) and the
    // authoritative provenance bit. `windowMetaRegionPresent == false` with
    // `windowDays == 90` is the absent-region default path; `true` means a
    // non-default window was explicitly DECODED from the bundle. The PTB version
    // is unchanged whether or not the region is present, so `/version` cannot
    // signal it.
    let window_days = gen.reader.window_days();
    let window_meta_region_present = gen.reader.window_meta_present();
    // B2 (I22): the `0x15 ServiceBitfieldPool` distinct-bitfield `count`, so
    // operators can confirm the de-dup pool decoded for this generation.
    let service_bitfield_pool_count_json = gen.reader.service_bitfield_pool_count().to_string();
    let city_tz_iana_json: String = if gen.city_tz_iana.is_empty() {
        "null".to_string()
    } else {
        json_string(&gen.city_tz_iana)
    };
    // C2b: the lowercase-hex SHA-256 of the canonical shapes JSON body this
    // generation is serving (derived from shapes.bin at load). `null` when no
    // shapes.bin was loaded. The Node backend advertises this hash so the
    // frontend never requests a shapes artifact that pt-serve doesn't have.
    let serving_shapes_json = match &gen.shapes_json_sha256 {
        Some(h) => json_string(h),
        None => "null".to_string(),
    };
    let serving_shapes_json_size = match gen.shapes_json_size_bytes {
        Some(size) => size.to_string(),
        None => "null".to_string(),
    };
    let poi_configured = ctx.config.poi_bundle_dir.is_some();
    let (poi_ready, poi_error) = match ctx.poi_manifest_cache.status() {
        crate::poi::catalog::PoiManifestStatus::Ready => (true, "null".to_string()),
        crate::poi::catalog::PoiManifestStatus::Failed(error) => (false, json_string(&error)),
        crate::poi::catalog::PoiManifestStatus::Cold => (false, "null".to_string()),
    };

    // generation_id may be empty in the P3 fallback path; render the
    // empty string verbatim (the field is a stable schema element).
    let body = format!(
        r#"{{"status":"ready","city":{city},"servingGenerationId":{gen_id},"servingBundleSha256":{bundle_sha},"servingLastGoodFallback":{fallback},"reloadConsecutiveFailures":{failures},"lastSuccessfulReloadAt":{last_reload},"manifestSchemaVersionMax":{schema_max},"generationAgeSecs":{age_secs},"feedStartDate":{feed_start},"feedStartDateAgeDays":{feed_age},"feedWindowStale":{stale},"lastGoodAgeExceedsRetention":{retention_breach},"forcedCurrentMode":{forced_current},"departuresIdxPresent":{dpix_present},"boardingRegionPresent":{boarding_present},"frequenciesRegionPresent":{frequencies_present},"windowDays":{window_days},"windowMetaRegionPresent":{window_meta_present},"serviceBitfieldPoolCount":{service_pool_count},"cityTzIana":{city_tz_iana},"servingShapesJsonSha256":{serving_shapes},"servingShapesJsonSizeBytes":{serving_shapes_size},"nowUnixSecs":{now_secs},"patternMode":{pattern_mode},"poiTile":{{"configured":{poi_configured},"ready":{poi_ready},"error":{poi_error}}}}}"#,
        city = json_string(&gen.city_slug),
        gen_id = json_string(&gen.generation_id),
        bundle_sha = json_string(&ptb_hash(gen)),
        fallback = ctx.metrics.startup_fallback_active(),
        failures = ctx.metrics.reload_consecutive_failures(),
        last_reload = last_successful_reload_at_json,
        schema_max = MANIFEST_SCHEMA_VERSION_MAX,
        age_secs = generation_age_secs_json,
        feed_start = feed_start_date,
        feed_age = feed_age_days,
        stale = feed_window_stale,
        retention_breach = last_good_age_exceeds_retention,
        forced_current = ctx.metrics.forced_current_mode_active(),
        dpix_present = departures_idx_present,
        boarding_present = boarding_region_present,
        frequencies_present = frequencies_region_present,
        window_days = window_days,
        window_meta_present = window_meta_region_present,
        service_pool_count = service_bitfield_pool_count_json,
        city_tz_iana = city_tz_iana_json,
        serving_shapes = serving_shapes_json,
        serving_shapes_size = serving_shapes_json_size,
        now_secs = now_unix_secs,
        pattern_mode = json_string(crate::ops::config::pattern_mode_token(gen.pattern_mode)),
        poi_configured = poi_configured,
        poi_ready = poi_ready,
        poi_error = poi_error,
    );
    json_response(200, body)
}

/// The PTB content hash, which the `/raptor-bundle` ETag carries. Timetable
/// bytes version independently of the publication id, so a sidecar-only
/// publication keeps this hash and clients revalidate the PTB with a 304.
fn ptb_hash(gen: &Generation) -> String {
    if gen.bundle_sha256.is_empty() {
        // P3 baseline `Generation::from_paths` leaves bundle_sha256 empty.
        // Fall back to the bundle_etag with its quotes stripped — the same
        // value the P3-era /version returned.
        gen.bundle_etag.trim_matches('"').to_string()
    } else {
        gen.bundle_sha256.clone()
    }
}

/// `/version` — PTN-named payload mirroring Node `/api/version`. The `created_at` field is also
/// surfaced here for parity with the manifest.
pub fn version(gen: &Generation, _ctx: &ServerCtx) -> Resp {
    let bundle_hash = ptb_hash(gen);
    // `ptbVersion` is sourced from the LIVE loaded bundle header
    // (`reader.header().version`), NOT the compile-time `pt_core::PTB_VERSION`
    // const. During a v5→v6 cutover (or a rollback) `/version` must report
    // what is actually being served, which only the parsed header knows.
    let ptb_version = gen.reader.header().version;
    let body = format!(
        r#"{{"version":{version},"commit":{commit},"builtAt":{built_at},"bundleHash":{bundle_hash},"generationId":{gen_id},"createdAt":{created_at},"manifestSchemaVersionMax":{schema_max},"ptbVersion":{ptb_version},"city":{city}}}"#,
        version = json_string(env!("CARGO_PKG_VERSION")),
        commit = json_string(env!("PT_SERVE_GIT_SHA")),
        built_at = json_string(env!("PT_SERVE_BUILT_AT")),
        bundle_hash = json_string(&bundle_hash),
        gen_id = json_string(&gen.generation_id),
        created_at = json_string(&gen.created_at),
        schema_max = MANIFEST_SCHEMA_VERSION_MAX,
        ptb_version = ptb_version,
        city = json_string(&gen.city_slug),
    );
    json_response(200, body)
}

/// Minimal JSON string escaper (no serde dep needed for these trivial payloads).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{LogFormat, Metrics, PatternModeArg, ServerCtx};
    use std::path::PathBuf;

    fn tiny_service_pool_ptb_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb")
    }

    /// Minimal `ServerConfig` for handler tests — `version()` ignores `ctx`,
    /// so the values are placeholders. Spelled out (vs `Parser::parse_from`)
    /// because several fields are required-without-default. Mirrors the
    /// `rss_guard.rs` test config idiom.
    fn test_config() -> crate::ops::config::ServerConfig {
        crate::ops::config::ServerConfig {
            worker_pool_size: 2,
            request_timeout_ms: 5_000,
            prestop_grace_secs: 1,
            max_rss_bytes: 1_073_741_824,
            process_fixed_overhead_bytes: 200_000_000,
            per_worker_overhead_bytes: 50_000_000,
            pidfile_path: PathBuf::from("/tmp/pt-serve.pid"),
            data_root: PathBuf::from("/tmp"),
            city_slug: "vilnius".into(),
            listen_addr: "127.0.0.1:0".into(),
            metrics_listen_addr: "127.0.0.1:0".into(),
            loopback_listen_addr: "127.0.0.1:0".into(),
            loopback_worker_count: 2,
            max_retained_generations: 10,
            page_warm_mode: crate::ops::PageWarmMode::WillNeed,
            log_format: LogFormat::Text,
            pattern_mode: PatternModeArg::Off,
            feed_stale_days: 80,
            force_current: None,
            city_tz_iana_default: Some("Europe/Vilnius".to_string()),
            health_probe: false,
            reload_poll_interval_secs: 0,
            rt_trip_updates_urls: String::new(),
            rt_poll_interval_ms: 12_000,
            schedule_tile_cache_max_bytes: 16 * 1024 * 1024,
            rt_tile_membership_cache_max_entries: 4096,
            rt_tile_response_cache_max_entries: 4096,
            rt_tile_response_cache_ttl_ms: 10_000,
            poi_bundle_dir: None,
            poi_lease_root: None,
            poi_bundle_max_decoded_bytes: 1024 * 1024,
            poi_tile_cache_max_entries: 256,
            poi_tile_cache_max_bytes: 2 * 1024 * 1024,
            validated_poi_manifest: None,
        }
    }

    fn body_of(resp: Resp) -> String {
        match resp {
            Resp::Json { body, .. } => body,
            _ => panic!("expected Resp::Json"),
        }
    }

    /// `/version` must surface the current PTB v1 header loaded from the
    /// committed fixture.
    #[test]
    fn version_body_carries_ptb_version_from_live_header() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        // Sanity: the fixture's live header is v1.
        assert_eq!(
            gen.reader.header().version,
            1,
            "tiny-service-pool.ptb fixture must parse as a v1 header"
        );

        let ctx = ServerCtx::new(gen, test_config(), Metrics::new());
        let gen_now = ctx.current_generation();
        let body = body_of(version(&gen_now, &ctx));
        assert!(
            body.contains(r#""ptbVersion":1"#),
            "/version body must carry the live header version; body: {body}"
        );
    }

    /// `/ready` must surface `boardingRegionPresent` wired to the live reader's
    /// boarding-predicate presence in either the `0xFA StopTimeBoarding` carry
    /// region or `0x12 PatternSemantics`. The committed `tiny-service-pool.ptb`
    /// fixture carries NEITHER region, so the flag reads `false` (every
    /// stop_time defaults to 0x50) — the `!(has_boarding() ||
    /// has_pattern_semantics())` expectation. The `true` case is covered by the
    /// pt-core reader unit tests and the producer round-trip. Because the PTB
    /// version field cannot signal which region (or whether either) is present,
    /// this flag is the only per-service signal of it.
    #[test]
    fn ready_body_carries_boarding_region_present_flag() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        // Sanity: the fixture has neither a 0xFA region NOR a 0x12 PatternSemantics
        // region (no band), so the reader reports both accessors absent ⇒ the
        // region-derived signal is false.
        assert!(
            !(gen.reader.has_boarding() || gen.reader.has_pattern_semantics()),
            "tiny-service-pool.ptb must have neither StopTimeBoarding (0xFA) nor PatternSemantics (0x12)"
        );

        let ctx = ServerCtx::new(gen, test_config(), Metrics::new());
        let gen_now = ctx.current_generation();
        let body = body_of(ready(&gen_now, &ctx));
        assert!(
            body.contains(r#""boardingRegionPresent":false"#),
            "/ready body must carry boardingRegionPresent wired to the live reader; body: {body}"
        );
    }

    /// `/ready` must surface `windowDays` + `windowMetaRegionPresent` wired to
    /// the live reader. The committed `tiny-service-pool.ptb` carries no `0x01
    /// WindowMeta` region, so the window floors to the default 90 and the
    /// provenance bit reads `false` (the absent-region default path). The
    /// `true` / non-90 case is covered by the pt-core reader unit tests (a
    /// windowed serve fixture does not exist yet); because the PTB version is
    /// unchanged whether or not the region is present, this flag is the only
    /// per-service signal of it.
    #[test]
    fn ready_body_carries_window_days_and_meta_present_flag() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        // Sanity: the fixture has no 0x01 WindowMeta region ⇒ default 90 / absent.
        assert!(
            !gen.reader.window_meta_present(),
            "tiny-service-pool.ptb must have no WindowMeta (0x01) region"
        );
        assert_eq!(gen.reader.window_days(), 90);

        let ctx = ServerCtx::new(gen, test_config(), Metrics::new());
        let gen_now = ctx.current_generation();
        let body = body_of(ready(&gen_now, &ctx));
        assert!(
            body.contains(r#""windowDays":90"#),
            "/ready body must carry windowDays wired to the live reader; body: {body}"
        );
        assert!(
            body.contains(r#""windowMetaRegionPresent":false"#),
            "/ready body must carry windowMetaRegionPresent wired to the live reader; body: {body}"
        );
    }

    /// `/ready` must surface `serviceBitfieldPoolCount` wired to the live
    /// reader's `0x15 ServiceBitfieldPool` `count` prefix. The committed
    /// current fixture (`tiny-service-pool.ptb`) carries a 2-entry pool, so
    /// the field reads `2`.
    #[test]
    fn ready_body_carries_service_bitfield_pool_count() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        // Sanity: the reader resolves the fixture's pool count.
        assert_eq!(gen.reader.service_bitfield_pool_count(), 2);
        let ctx = ServerCtx::new(gen, test_config(), Metrics::new());
        let gen_now = ctx.current_generation();
        let body = body_of(ready(&gen_now, &ctx));
        assert!(
            body.contains(r#""serviceBitfieldPoolCount":2"#),
            "/ready body must carry serviceBitfieldPoolCount wired to the live reader; body: {body}"
        );
    }

    /// `/ready` must surface `servingShapesJsonSha256` from the live generation's
    /// `shapes_json_sha256` field. The committed `tiny-service-pool.ptb` has no
    /// `shapes.bin` sidecar in its fixture directory, so the field is `null`. The
    /// populated-hash case is proven by the route-parity gate (a different task)
    /// where a shapes-sidecar-bearing generation is loaded.
    #[test]
    fn ready_body_includes_serving_shapes_hash_null_when_absent() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        // Sanity: the fixture directory has no shapes.bin → sha256 is None.
        assert!(
            gen.shapes_json_sha256.is_none(),
            "tiny-service-pool.ptb must have no shapes.bin sidecar"
        );
        let ctx = ServerCtx::new(gen, test_config(), Metrics::new());
        let gen_now = ctx.current_generation();
        let body = body_of(ready(&gen_now, &ctx));
        assert!(
            body.contains(r#""servingShapesJsonSha256":null"#),
            "got: {body}"
        );
        assert!(
            body.contains(r#""servingShapesJsonSizeBytes":null"#),
            "got: {body}"
        );
    }

    /// `/ready` must surface `frequenciesRegionPresent` wired to the
    /// live reader's `has_frequencies()`. The committed `tiny-service-pool.ptb`
    /// carries no `0x17 Frequencies` region → `false`; `frequencies-parity.ptb`
    /// carries three rows → `true`. Together they prove the field tracks the
    /// served bundle.
    #[test]
    fn ready_body_carries_frequencies_region_present_flag() {
        // ── absent case: tiny-service-pool.ptb has no 0x17 Frequencies region ──
        let gen_absent = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        assert!(
            !gen_absent.reader.has_frequencies(),
            "tiny-service-pool.ptb must have no Frequencies (0x17) region"
        );
        let ctx_absent = ServerCtx::new(gen_absent, test_config(), Metrics::new());
        let gen_now_absent = ctx_absent.current_generation();
        let body_absent = body_of(ready(&gen_now_absent, &ctx_absent));
        assert!(
            body_absent.contains(r#""frequenciesRegionPresent":false"#),
            "/ready body must carry frequenciesRegionPresent:false for absent region; body: {body_absent}"
        );

        // ── present case: frequencies-parity.ptb carries 3 frequency rows ────
        let parity_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/shared/src/ptb/__fixtures__/frequencies-parity.ptb");
        let gen_present = Generation::from_paths(
            &parity_path,
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over frequencies-parity.ptb");
        assert!(
            gen_present.reader.has_frequencies(),
            "frequencies-parity.ptb must have Frequencies (0x17) region"
        );
        let ctx_present = ServerCtx::new(gen_present, test_config(), Metrics::new());
        let gen_now_present = ctx_present.current_generation();
        let body_present = body_of(ready(&gen_now_present, &ctx_present));
        assert!(
            body_present.contains(r#""frequenciesRegionPresent":true"#),
            "/ready body must carry frequenciesRegionPresent:true for present region; body: {body_present}"
        );
    }

    #[test]
    fn poi_preflight_failure_is_reported_without_lowering_readiness() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        let mut config = test_config();
        config.poi_bundle_dir = Some(PathBuf::from("/tmp/poi"));
        config.validated_poi_manifest = Some(crate::poi::catalog::PoiPreflightState::Failed(
            std::sync::Arc::from("invalid \"POI\" manifest"),
        ));
        let ctx = ServerCtx::new(gen, config, Metrics::new());
        let gen_now = ctx.current_generation();

        let Resp::Json { status, body } = ready(&gen_now, &ctx) else {
            panic!("expected JSON readiness response");
        };
        assert_eq!(status, 200);
        let value: serde_json::Value = serde_json::from_str(&body).expect("valid readiness JSON");
        assert_eq!(value["status"], "ready");
        assert_eq!(
            value["poiTile"],
            serde_json::json!({
                "configured": true,
                "ready": false,
                "error": "invalid \"POI\" manifest"
            })
        );
    }

    #[test]
    fn poi_readiness_tracks_late_manifest_preflight() {
        let gen = Generation::from_paths(
            &tiny_service_pool_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("Generation::from_paths over tiny-service-pool.ptb");
        let dir = tempfile::TempDir::new().expect("temp POI dir");
        let mut config = test_config();
        config.poi_bundle_dir = Some(dir.path().to_path_buf());
        config.validated_poi_manifest = Some(crate::poi::catalog::PoiPreflightState::Cold);
        let ctx = ServerCtx::new(gen, config, Metrics::new());
        let gen_now = ctx.current_generation();

        let cold: serde_json::Value =
            serde_json::from_str(&body_of(ready(&gen_now, &ctx))).expect("cold readiness JSON");
        assert_eq!(cold["poiTile"]["ready"], false);

        std::fs::write(
            dir.path().join("manifest.json"),
            br#"{"schemaVersion":1,"bundles":[]}"#,
        )
        .expect("publish manifest");
        ctx.poi_manifest_cache
            .get_or_load(&ctx.config)
            .expect("late preflight succeeds")
            .expect("late manifest exists");

        let live: serde_json::Value =
            serde_json::from_str(&body_of(ready(&gen_now, &ctx))).expect("live readiness JSON");
        assert_eq!(live["poiTile"]["ready"], true);
        assert_eq!(live["poiTile"]["error"], serde_json::Value::Null);
    }
}
