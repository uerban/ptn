// crates/pt-serve/tests/alerts.rs
//
// GTFS-RT ServiceAlerts: the decoder (`rt::alerts`), the poll cycle and its
// published reply (`rt::alerts_state`), `GET /api/<city>/alerts`, the alert
// section of `/health/rt`, and the `X-PT-Realtime` header on
// `GET /api/<city>/gtfs/manifest`.
//
// Feeds are encoded here, field by field, so each test states exactly which
// wire fields it exercises.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::app::alerts::service_alerts;
use pt_serve::app::gtfs_manifest::{gtfs_manifest, gtfs_manifest_with_realtime};
use pt_serve::app::response::{ByteBody, Resp};
use pt_serve::app::rt_health::rt_health;
use pt_serve::ops::config::LogFormat;
use pt_serve::router::{resolve, ListenerKind, Route};
use pt_serve::rt::alerts::{
    parse_alerts_buffer, ActivePeriod, AlertsParseError, Cause, Effect, EntitySelector, FeedAlerts,
    Severity, Translation, MAX_ACTIVE_PERIODS, MAX_ALERTS_PER_FEED, MAX_DESCRIPTION_CHARS,
    MAX_FEED_TEXT_BYTES, MAX_HEADER_CHARS, MAX_INFORMED_ENTITIES, MAX_TRANSLATIONS,
};
use pt_serve::rt::alerts_state::{
    merge_alerts, run_alerts_cycle, stale_after, AlertsCycle, AlertsPoller, AlertsState, KnownIds,
    MIN_STALE_AFTER,
};
use pt_serve::rt::poller::FeedStatus;
use pt_serve::{Generation, Metrics, ServerCtx};
use pt_shared::clock::MockClock;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

// ---------------------------------------------------------------------------
// Wire encoding helpers
// ---------------------------------------------------------------------------

fn varint(mut v: u64, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn tag(field: u32, wire_type: u8, out: &mut Vec<u8>) {
    varint(((field as u64) << 3) | wire_type as u64, out);
}

/// A length-delimited field.
fn ld(field: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    tag(field, 2, &mut out);
    varint(data.len() as u64, &mut out);
    out.extend_from_slice(data);
    out
}

/// A varint field.
fn vi(field: u32, v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    tag(field, 0, &mut out);
    varint(v, &mut out);
    out
}

fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

fn feed_header() -> Vec<u8> {
    ld(1, &cat(&[ld(1, b"2.0"), vi(2, 0), vi(3, 1_700_000_000)]))
}

fn feed(entities: &[Vec<u8>]) -> Vec<u8> {
    let mut out = feed_header();
    for e in entities {
        out.extend(ld(2, e));
    }
    out
}

/// A `FeedEntity` carrying `alert`.
fn alert_entity(id: &str, alert: &[Vec<u8>]) -> Vec<u8> {
    cat(&[ld(1, id.as_bytes()), ld(5, &cat(alert))])
}

/// `TranslatedString` field `field` with the given translations.
fn text(field: u32, translations: &[(&str, Option<&str>)]) -> Vec<u8> {
    let mut ts = Vec::new();
    for (t, lang) in translations {
        let mut tr = ld(1, t.as_bytes());
        if let Some(l) = lang {
            tr.extend(ld(2, l.as_bytes()));
        }
        ts.extend(ld(1, &tr));
    }
    ld(field, &ts)
}

fn period(start: Option<u64>, end: Option<u64>) -> Vec<u8> {
    let mut p = Vec::new();
    if let Some(s) = start {
        p.extend(vi(1, s));
    }
    if let Some(e) = end {
        p.extend(vi(2, e));
    }
    ld(1, &p)
}

fn selector(parts: &[Vec<u8>]) -> Vec<u8> {
    ld(5, &cat(parts))
}

fn route_sel(route_id: &str) -> Vec<u8> {
    selector(&[ld(2, route_id.as_bytes())])
}

/// A minimal valid alert: one header, one route selector.
fn simple_alert(id: &str, route_id: &str) -> Vec<u8> {
    alert_entity(
        id,
        &[
            text(10, &[(&format!("header {id}"), None)]),
            route_sel(route_id),
        ],
    )
}

fn parse(bytes: &[u8]) -> FeedAlerts {
    parse_alerts_buffer(bytes).expect("feed parses")
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

#[test]
fn decodes_every_alert_field() {
    let trip_descriptor = ld(
        4,
        &cat(&[
            ld(1, b"T1"),
            ld(2, b"08:00:00"),
            ld(3, b"20261107"),
            vi(4, 0),
            ld(5, b"R-trip"),
            vi(6, 1),
        ]),
    );
    let bytes = feed(&[alert_entity(
        "a1",
        &[
            period(Some(1_000), Some(2_000)),
            period(Some(3_000), None),
            selector(&[ld(1, b"AG"), ld(2, b"R1"), vi(3, 3), ld(5, b"S1"), vi(6, 0)]),
            // trip_id from the descriptor; its route and direction fill in.
            selector(&[trip_descriptor]),
            vi(6, 10), // CONSTRUCTION
            vi(7, 4),  // DETOUR
            text(8, &[("https://example.test/a1", Some("en"))]),
            text(
                10,
                &[("Tram diverted", Some("en")), ("Tramvajus", Some("lt"))],
            ),
            text(
                11,
                &[("Line 4 runs via Main St.\nExpect delays.", Some("en"))],
            ),
            text(12, &[("tts header", None)]),
            text(13, &[("tts description", None)]),
            vi(14, 3), // WARNING
            vi(15, 1), // cause_detail-style future field, skipped
        ],
    )]);
    let out = parse(&bytes);
    assert_eq!(out.dropped_alerts, 0);
    assert_eq!(out.dropped_selectors, 0);
    assert_eq!(out.alerts.len(), 1);
    let a = &out.alerts[0];
    assert_eq!(&*a.id, "a1");
    assert_eq!(a.cause, Cause::Construction);
    assert_eq!(a.effect, Effect::Detour);
    assert_eq!(a.severity, Severity::Warning);
    let tr = |t: &str, l: Option<&str>| Translation {
        text: t.into(),
        language: l.map(Into::into),
    };
    assert_eq!(
        a.header,
        vec![tr("Tram diverted", Some("en")), tr("Tramvajus", Some("lt"))]
    );
    assert_eq!(
        a.description,
        vec![tr("Line 4 runs via Main St.\nExpect delays.", Some("en"))]
    );
    assert_eq!(a.url, vec![tr("https://example.test/a1", Some("en"))]);
    assert_eq!(
        a.active_periods,
        vec![
            ActivePeriod {
                start: Some(1_000),
                end: Some(2_000)
            },
            ActivePeriod {
                start: Some(3_000),
                end: None
            },
        ]
    );
    assert_eq!(
        a.informed_entities,
        vec![
            EntitySelector {
                agency_id: Some("AG".into()),
                route_id: Some("R1".into()),
                route_type: Some(3),
                direction_id: Some(0),
                trip_id: None,
                stop_id: Some("S1".into()),
            },
            EntitySelector {
                trip_id: Some("T1".into()),
                route_id: Some("R-trip".into()),
                direction_id: Some(1),
                ..Default::default()
            },
        ]
    );
}

#[test]
fn absent_enums_read_as_unknown() {
    let out = parse(&feed(&[simple_alert("a", "R1")]));
    let a = &out.alerts[0];
    assert_eq!(a.cause, Cause::UnknownCause);
    assert_eq!(a.effect, Effect::UnknownEffect);
    assert_eq!(a.severity, Severity::Unknown);
    assert!(a.description.is_empty() && a.url.is_empty() && a.active_periods.is_empty());
}

#[test]
fn unknown_fields_are_skipped_at_every_level() {
    // Field 99 in each wire type the reader can skip: varint, fixed64,
    // length-delimited, fixed32, and a group.
    let unknowns = || {
        let mut u = vi(99, 7);
        tag(98, 1, &mut u);
        u.extend([0u8; 8]);
        u.extend(ld(97, b"vendor"));
        tag(96, 5, &mut u);
        u.extend([0u8; 4]);
        tag(95, 3, &mut u);
        u.extend(vi(1, 1));
        tag(95, 4, &mut u);
        u
    };
    let translation = cat(&[ld(1, b"hello"), unknowns()]);
    let alert = cat(&[
        ld(10, &cat(&[ld(1, &translation), unknowns()])),
        ld(5, &cat(&[ld(2, b"R1"), unknowns()])),
        ld(1, &cat(&[vi(1, 10), unknowns()])),
        unknowns(),
    ]);
    let entity = cat(&[ld(1, b"a"), ld(5, &alert), unknowns()]);
    let mut bytes = ld(1, &cat(&[ld(1, b"2.0"), unknowns()]));
    bytes.extend(ld(2, &entity));
    bytes.extend(unknowns());
    let out = parse(&bytes);
    assert_eq!(out.alerts.len(), 1);
    assert_eq!(&*out.alerts[0].header[0].text, "hello");
    assert_eq!(
        out.alerts[0].informed_entities[0].route_id.as_deref(),
        Some("R1")
    );
    assert_eq!(out.alerts[0].active_periods[0].start, Some(10));
}

#[test]
fn malformed_input_fails_the_whole_feed() {
    let good = feed(&[simple_alert("a", "R1")]);
    // Empty body: no header.
    assert_eq!(parse_alerts_buffer(&[]), Err(AlertsParseError::Malformed));
    // Truncated mid-entity.
    assert_eq!(
        parse_alerts_buffer(&good[..good.len() - 3]),
        Err(AlertsParseError::Malformed)
    );
    // Header without the required version.
    let mut no_version = ld(1, &vi(3, 1));
    no_version.extend(ld(2, &simple_alert("a", "R1")));
    assert_eq!(
        parse_alerts_buffer(&no_version),
        Err(AlertsParseError::Malformed)
    );
    // Entity without the required id.
    let no_id = feed(&[ld(5, &route_sel("R1"))]);
    assert_eq!(
        parse_alerts_buffer(&no_id),
        Err(AlertsParseError::Malformed)
    );
    // Translation without the required text.
    let no_text = feed(&[alert_entity(
        "a",
        &[ld(10, &ld(1, &ld(2, b"en"))), route_sel("R1")],
    )]);
    assert_eq!(
        parse_alerts_buffer(&no_text),
        Err(AlertsParseError::Malformed)
    );
    // A length prefix past the end.
    let mut overrun = feed_header();
    overrun.extend([0x12, 0x7f, 0x0a]);
    assert_eq!(
        parse_alerts_buffer(&overrun),
        Err(AlertsParseError::Malformed)
    );
    // A stray end-group tag.
    let mut end_group = feed_header();
    tag(7, 4, &mut end_group);
    assert_eq!(
        parse_alerts_buffer(&end_group),
        Err(AlertsParseError::Malformed)
    );
}

#[test]
fn only_full_dataset_feeds_are_accepted() {
    let mut differential = ld(1, &cat(&[ld(1, b"2.0"), vi(2, 1)]));
    differential.extend(ld(2, &simple_alert("a", "R1")));
    assert_eq!(
        parse_alerts_buffer(&differential),
        Err(AlertsParseError::Differential)
    );
}

#[test]
fn deleted_and_non_alert_entities_are_skipped() {
    let deleted = cat(&[ld(1, b"gone"), vi(2, 1), ld(5, &cat(&[route_sel("R1")]))]);
    let trip_update = cat(&[ld(1, b"tu"), ld(3, &ld(1, &ld(1, b"T1")))]);
    let out = parse(&feed(&[deleted, trip_update, simple_alert("kept", "R1")]));
    assert_eq!(out.alerts.len(), 1);
    assert_eq!(&*out.alerts[0].id, "kept");
    assert_eq!(out.dropped_alerts, 0);
}

#[test]
fn a_duplicate_id_replaces_the_earlier_alert_in_place() {
    let out = parse(&feed(&[
        simple_alert("a", "R1"),
        simple_alert("b", "R2"),
        simple_alert("a", "R3"),
    ]));
    let ids: Vec<&str> = out.alerts.iter().map(|a| &*a.id).collect();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(
        out.alerts[0].informed_entities[0].route_id.as_deref(),
        Some("R3")
    );
}

#[test]
fn unusable_selectors_are_dropped_and_counted() {
    let long_id = "x".repeat(300);
    let out = parse(&feed(&[
        alert_entity(
            "a",
            &[
                route_sel("R1"),
                selector(&[vi(6, 2)]),                         // direction 2
                selector(&[ld(5, long_id.as_bytes())]),        // over-long id
                selector(&[ld(5, b"S\x01")]),                  // control char
                selector(&[ld(97, b"only an unknown field")]), // empty
                selector(&[ld(4, &cat(&[ld(1, b"T1"), vi(6, 9)]))]), // bad trip direction
            ],
        ),
        // Every selector unusable: the alert goes too.
        alert_entity("b", &[text(10, &[("x", None)]), selector(&[vi(6, 5)])]),
        // No selector at all.
        alert_entity("c", &[text(10, &[("x", None)])]),
        // Empty id.
        alert_entity("", &[route_sel("R1")]),
    ]));
    assert_eq!(out.alerts.len(), 1);
    assert_eq!(out.alerts[0].informed_entities.len(), 1);
    assert_eq!(out.dropped_selectors, 6);
    assert_eq!(out.dropped_alerts, 3);
}

#[test]
fn texts_are_sanitised_and_unsafe_urls_dropped() {
    let out = parse(&feed(&[alert_entity(
        "a",
        &[
            text(10, &[("  Line\u{202E} 4\x07 \r\nclosed  ", Some("en US"))]),
            text(11, &[("one\r\ntwo\x00", None)]),
            text(
                8,
                &[
                    ("javascript:alert(1)", None),
                    ("https://example.test/ok", None),
                ],
            ),
            route_sel("R1"),
        ],
    )]));
    let a = &out.alerts[0];
    assert_eq!(&*a.header[0].text, "Line 4  closed");
    assert_eq!(a.header[0].language, None, "not a language tag");
    assert_eq!(&*a.description[0].text, "one\ntwo");
    assert_eq!(a.url.len(), 1);
    assert_eq!(&*a.url[0].text, "https://example.test/ok");
}

#[test]
fn per_alert_caps_hold() {
    let translations: Vec<(String, Option<&str>)> = (0..MAX_TRANSLATIONS + 5)
        .map(|i| (format!("t{i}"), None))
        .collect();
    let translations: Vec<(&str, Option<&str>)> =
        translations.iter().map(|(t, l)| (t.as_str(), *l)).collect();
    let long_header = "h".repeat(MAX_HEADER_CHARS * 2);
    let long_description = "d".repeat(MAX_DESCRIPTION_CHARS + 10);
    let mut parts = vec![
        text(10, &[(long_header.as_str(), None)]),
        text(11, &[(long_description.as_str(), None)]),
        text(8, &translations),
    ];
    for i in 0..MAX_ACTIVE_PERIODS + 3 {
        parts.push(period(Some(i as u64 + 1), None));
    }
    for i in 0..MAX_INFORMED_ENTITIES + 4 {
        parts.push(route_sel(&format!("R{i}")));
    }
    let out = parse(&feed(&[alert_entity("a", &parts)]));
    let a = &out.alerts[0];
    assert_eq!(a.header[0].text.chars().count(), MAX_HEADER_CHARS);
    assert!(a.header[0].text.ends_with('…'));
    assert_eq!(a.description[0].text.chars().count(), MAX_DESCRIPTION_CHARS);
    // URLs: "t0".. are not http(s), so none survive — use header for count.
    assert!(a.url.is_empty());
    assert_eq!(a.active_periods.len(), MAX_ACTIVE_PERIODS);
    assert_eq!(a.informed_entities.len(), MAX_INFORMED_ENTITIES);
    assert_eq!(out.dropped_selectors, 4);

    let many = parse(&feed(&[alert_entity(
        "b",
        &[text(10, &translations), route_sel("R1")],
    )]));
    assert_eq!(many.alerts[0].header.len(), MAX_TRANSLATIONS);
}

#[test]
fn alert_count_cap_holds() {
    let entities: Vec<Vec<u8>> = (0..MAX_ALERTS_PER_FEED + 7)
        .map(|i| simple_alert(&format!("a{i}"), "R1"))
        .collect();
    let out = parse(&feed(&entities));
    assert_eq!(out.alerts.len(), MAX_ALERTS_PER_FEED);
    assert_eq!(out.dropped_alerts, 7);
}

#[test]
fn feed_text_budget_holds() {
    // Each alert keeps ~4 KiB of description; the budget runs out well
    // before the alert-count cap.
    let description = "d".repeat(MAX_DESCRIPTION_CHARS);
    let per_alert = MAX_DESCRIPTION_CHARS + 16;
    let fits = MAX_FEED_TEXT_BYTES / per_alert;
    let entities: Vec<Vec<u8>> = (0..fits + 20)
        .map(|i| {
            alert_entity(
                &format!("a{i:05}"),
                &[text(11, &[(description.as_str(), None)]), route_sel("R1")],
            )
        })
        .collect();
    let out = parse(&feed(&entities));
    assert!(out.alerts.len() < fits + 20);
    assert!(out.alerts.len() + 1 >= fits);
    assert_eq!(
        out.alerts.len() as u32 + out.dropped_alerts,
        (fits + 20) as u32
    );
    let kept: usize = out
        .alerts
        .iter()
        .map(|a| a.id.len() + a.description[0].text.len() + 2)
        .sum();
    assert!(kept <= MAX_FEED_TEXT_BYTES);
}

// ---------------------------------------------------------------------------
// Merge, expiry, resolution
// ---------------------------------------------------------------------------

#[test]
fn feeds_merge_in_configured_order_and_later_feeds_win() {
    let a = parse(&feed(&[simple_alert("x", "R1"), simple_alert("y", "R1")]));
    let b = parse(&feed(&[simple_alert("x", "R2"), simple_alert("z", "R2")]));
    let (alerts, stats) = merge_alerts([&a, &b], 0, None);
    let ids: Vec<&str> = alerts.iter().map(|a| &*a.id).collect();
    assert_eq!(ids, ["x", "y", "z"]);
    assert_eq!(
        alerts[0].informed_entities[0].route_id.as_deref(),
        Some("R2")
    );
    assert_eq!(stats.served, 3);
}

#[test]
fn alerts_whose_periods_all_ended_are_dropped() {
    let f = parse(&feed(&[
        alert_entity("ended", &[period(Some(10), Some(100)), route_sel("R1")]),
        alert_entity(
            "later",
            &[
                period(None, Some(100)),
                period(Some(500), None),
                route_sel("R1"),
            ],
        ),
        alert_entity("always", &[route_sel("R1")]),
    ]));
    let (alerts, stats) = merge_alerts([&f], 100, None);
    let ids: Vec<&str> = alerts.iter().map(|a| &*a.id).collect();
    assert_eq!(ids, ["later", "always"]);
    assert_eq!(stats.expired, 1);
}

#[test]
fn selectors_resolve_against_bundle_ids() {
    let f = parse(&feed(&[
        alert_entity(
            "a",
            &[
                route_sel("R1"),
                route_sel("R-missing"),
                selector(&[ld(5, b"S1")]),
                selector(&[ld(2, b"R1"), ld(5, b"S-missing")]),
                selector(&[ld(4, &ld(1, b"T1"))]),
                selector(&[vi(3, 0)]), // route_type only: no id to check
            ],
        ),
        alert_entity("b", &[route_sel("R-missing")]),
    ]));
    let known = KnownIds::from_ids(["R1"], ["S1"], ["T1"], []);
    let (alerts, stats) = merge_alerts([&f], 0, Some(&known));
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].informed_entities.len(), 4);
    assert_eq!(stats.dropped_selectors, 3);
    assert_eq!(stats.dropped_alerts, 1);
}

#[test]
fn agency_selectors_are_checked_only_when_the_bundle_has_agency_ids() {
    let f = parse(&feed(&[alert_entity("a", &[selector(&[ld(1, b"AG")])])]));
    let without = KnownIds::from_ids([], [], [], []);
    assert_eq!(merge_alerts([&f], 0, Some(&without)).0.len(), 1);
    let other = KnownIds::from_ids([], [], [], ["OTHER"]);
    assert_eq!(merge_alerts([&f], 0, Some(&other)).0.len(), 0);
    let same = KnownIds::from_ids([], [], [], ["AG"]);
    assert_eq!(merge_alerts([&f], 0, Some(&same)).0.len(), 1);
}

fn tiny_generation() -> Generation {
    Generation::from_paths(
        &common::tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("generation builds from tiny.ptb")
}

#[test]
fn known_ids_come_from_the_generation() {
    let gen = tiny_generation();
    let route = gen.reader.route_id(0).unwrap().to_string();
    let stop = gen.reader.stop_id(0).unwrap().to_string();
    let trip = gen.reader.trip_id(0).unwrap().to_string();
    let f = parse(&feed(&[alert_entity(
        "a",
        &[
            route_sel(&route),
            selector(&[ld(5, stop.as_bytes())]),
            selector(&[ld(4, &ld(1, trip.as_bytes()))]),
            route_sel("not-in-tiny"),
            selector(&[ld(5, b"not-in-tiny")]),
            selector(&[ld(4, &ld(1, b"not-in-tiny"))]),
        ],
    )]));
    let known = KnownIds::from_generation(&gen, &f.alerts);
    let (alerts, stats) = merge_alerts([&f], 0, Some(&known));
    assert_eq!(alerts[0].informed_entities.len(), 3);
    assert_eq!(stats.dropped_selectors, 3);
}

// ---------------------------------------------------------------------------
// Poll cycle: last-good retention, staleness, the published reply
// ---------------------------------------------------------------------------

const T0: u64 = 1_800_000_000; // seconds

struct Harness {
    poller: AlertsPoller,
    state: Arc<AlertsState>,
    clock: MockClock,
}

impl Harness {
    fn new(urls: &[&str]) -> Self {
        let urls: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
        Self {
            poller: AlertsPoller::new(urls.clone()).unwrap(),
            state: AlertsState::from_urls(urls),
            clock: MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(T0)),
        }
    }

    /// One cycle; `responses` are consumed in fetch order (one per feed,
    /// plus one per retry of a body that does not parse).
    fn cycle(&mut self, responses: Vec<Result<Vec<u8>, String>>, gen: Option<Arc<Generation>>) {
        let mut responses = VecDeque::from(responses);
        let cycle = AlertsCycle {
            city: "vilnius",
            clock: &self.clock,
            log_format: LogFormat::Text,
            stale_after: MIN_STALE_AFTER,
            retry_delay: Duration::ZERO,
        };
        run_alerts_cycle(
            &mut self.poller,
            &self.state,
            &cycle,
            &mut |_| responses.pop_front().expect("fetched more than scripted"),
            &|| gen.clone(),
        );
        assert!(responses.is_empty(), "every scripted response is used");
    }

    fn reply_json(&self) -> serde_json::Value {
        let snap = self.state.load();
        let reply = snap.reply.as_ref().expect("a reply is published");
        serde_json::from_slice(&reply.body).unwrap()
    }
}

#[test]
fn nothing_is_served_until_a_feed_succeeds() {
    let mut h = Harness::new(&["http://a.test/alerts.pb"]);
    assert!(h.state.load().reply.is_none());
    h.cycle(vec![Err("HTTP 503".into())], None);
    let snap = h.state.load();
    assert!(snap.reply.is_none());
    assert_eq!(snap.health[0].status, FeedStatus::Failed);
}

#[test]
fn the_reply_matches_the_shared_contract() {
    let mut h = Harness::new(&["http://a.test/alerts.pb"]);
    let bytes = feed(&[alert_entity(
        "a1",
        &[
            period(Some(T0 - 60), Some(T0 + 3600)),
            selector(&[ld(2, b"R1"), vi(6, 1)]),
            vi(6, 4),
            vi(7, 1),
            vi(14, 4),
            text(10, &[("Strike", Some("en"))]),
        ],
    )]);
    h.cycle(vec![Ok(bytes)], None);
    // The same file is parsed by the frontend client's tests, so a field the
    // server renames or reshapes fails on both sides.
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/shared/src/types/__fixtures__/service-alerts-response.json"
    ))
    .unwrap();
    assert_eq!(h.reply_json(), golden);
}

#[test]
fn a_failing_feed_keeps_its_last_good_alerts_and_goes_stale() {
    let mut h = Harness::new(&["http://a.test/alerts.pb"]);
    h.cycle(vec![Ok(feed(&[simple_alert("a", "R1")]))], None);
    let first_etag = h.state.load().reply.as_ref().unwrap().etag.clone();

    h.clock.advance(Duration::from_secs(60));
    // A body that never parses is fetched twice, then the feed fails.
    h.cycle(vec![Ok(vec![0x0a]), Ok(vec![0x0a])], None);
    let snap = h.state.load();
    assert_eq!(snap.health[0].status, FeedStatus::Failed);
    let v = h.reply_json();
    assert_eq!(v["alerts"][0]["id"], "a");
    assert_eq!(v["stale"], false);
    assert_eq!(v["fetchedAt"], "2027-01-15T08:00:00.000Z");
    assert_eq!(snap.reply.as_ref().unwrap().etag, first_etag);

    h.clock.advance(MIN_STALE_AFTER);
    h.cycle(vec![Err("timeout".into())], None);
    let v = h.reply_json();
    assert_eq!(v["stale"], true);
    assert_eq!(v["alerts"][0]["id"], "a", "stale alerts are still served");
    assert_eq!(v["fetchedAt"], "2027-01-15T08:00:00.000Z");
    assert_ne!(h.state.load().reply.as_ref().unwrap().etag, first_etag);
}

#[test]
fn multi_feed_cycle_merges_and_reports_each_feed() {
    let mut h = Harness::new(&["http://a.test/a.pb", "http://a.test/b.pb"]);
    h.cycle(
        vec![
            Ok(feed(&[
                simple_alert("shared", "R1"),
                simple_alert("a-only", "R1"),
            ])),
            Ok(feed(&[simple_alert("shared", "R2")])),
        ],
        None,
    );
    let v = h.reply_json();
    let ids: Vec<&str> = v["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["shared", "a-only"]);
    assert_eq!(v["alerts"][0]["informedEntities"][0]["routeId"], "R2");
    assert_eq!(v["stale"], false);

    // The second feed never recovers: the first's alerts stay served, the
    // reply goes stale, and health shows which feed failed.
    let mut h = Harness::new(&["http://a.test/a.pb", "http://a.test/b.pb"]);
    h.cycle(
        vec![Ok(feed(&[simple_alert("a", "R1")])), Err("HTTP 500".into())],
        None,
    );
    let snap = h.state.load();
    assert_eq!(snap.health[0].status, FeedStatus::Ok);
    assert_eq!(snap.health[1].status, FeedStatus::Failed);
    let v = h.reply_json();
    assert_eq!(v["alerts"][0]["id"], "a");
    assert_eq!(v["stale"], true);
}

#[test]
fn expiry_is_applied_each_cycle_even_without_new_data() {
    let mut h = Harness::new(&["http://a.test/alerts.pb"]);
    let bytes = feed(&[alert_entity(
        "short",
        &[period(None, Some(T0 + 30)), route_sel("R1")],
    )]);
    h.cycle(vec![Ok(bytes)], None);
    assert_eq!(h.reply_json()["alerts"].as_array().unwrap().len(), 1);
    h.clock.advance(Duration::from_secs(31));
    h.cycle(vec![Err("HTTP 503".into())], None);
    assert!(h.reply_json()["alerts"].as_array().unwrap().is_empty());
    assert_eq!(h.state.load().stats.expired, 1);
}

#[test]
fn the_cycle_resolves_against_the_current_generation() {
    let gen = Arc::new(tiny_generation());
    let route = gen.reader.route_id(0).unwrap().to_string();
    let mut h = Harness::new(&["http://a.test/alerts.pb"]);
    h.cycle(
        vec![Ok(feed(&[
            alert_entity("in", &[route_sel(&route), route_sel("nope")]),
            simple_alert("out", "nope"),
        ]))],
        Some(Arc::clone(&gen)),
    );
    let v = h.reply_json();
    assert_eq!(v["alerts"].as_array().unwrap().len(), 1);
    assert_eq!(v["alerts"][0]["id"], "in");
    let stats = h.state.load().stats;
    assert_eq!(stats.dropped_selectors, 2);
    assert_eq!(stats.dropped_alerts, 1);
    assert_eq!(stats.served, 1);
}

#[test]
fn stale_threshold_scales_with_the_poll_interval() {
    assert_eq!(stale_after(Duration::from_secs(10)), MIN_STALE_AFTER);
    assert_eq!(
        stale_after(Duration::from_secs(600)),
        Duration::from_secs(1800)
    );
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

fn ctx_with_alerts(urls: &str) -> (tempfile::TempDir, Arc<ServerCtx>) {
    let (dir, mut config, _clock) = common::isolated_config();
    config.rt_service_alerts_urls = urls.to_string();
    let ctx = ServerCtx::new(tiny_generation(), config, Arc::new(Metrics::default()));
    (dir, ctx)
}

struct Cached {
    status: u16,
    body: Vec<u8>,
    etag: Option<String>,
    cache_control: &'static str,
}

fn cached(resp: Resp) -> Cached {
    match resp {
        Resp::CachedBytes {
            status,
            body,
            cache_control,
            etag,
            ..
        } => {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut body.into_reader(), &mut bytes).unwrap();
            Cached {
                status,
                body: bytes,
                etag,
                cache_control,
            }
        }
        _ => panic!("expected Resp::CachedBytes"),
    }
}

#[test]
fn alerts_route_is_404_when_not_configured() {
    let (_dir, ctx) = ctx_with_alerts("");
    let r = cached(service_alerts(&ctx, None));
    assert_eq!(r.status, 404);
    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(v["error"]["code"], "ALERTS_NOT_CONFIGURED");
}

#[test]
fn alerts_route_is_503_until_the_first_success() {
    let (_dir, ctx) = ctx_with_alerts("http://a.test/alerts.pb");
    let r = cached(service_alerts(&ctx, None));
    assert_eq!(r.status, 503);
    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(v["error"]["code"], "ALERTS_UNAVAILABLE");
}

#[test]
fn alerts_route_serves_the_reply_with_an_etag() {
    let (_dir, ctx) = ctx_with_alerts("http://a.test/alerts.pb");
    let mut poller = AlertsPoller::new(vec!["http://a.test/alerts.pb".into()]).unwrap();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(T0));
    let cycle = AlertsCycle {
        city: "vilnius",
        clock: &clock,
        log_format: LogFormat::Text,
        stale_after: MIN_STALE_AFTER,
        retry_delay: Duration::ZERO,
    };
    let mut bytes = Some(feed(&[simple_alert("a", "R1")]));
    run_alerts_cycle(
        &mut poller,
        &ctx.alerts,
        &cycle,
        &mut |_| Ok(bytes.take().unwrap()),
        &|| None,
    );

    let ok = cached(service_alerts(&ctx, None));
    assert_eq!(ok.status, 200);
    assert_eq!(ok.cache_control, "no-cache");
    let etag = ok.etag.clone().expect("200 carries an ETag");
    assert!(etag.starts_with('"') && etag.ends_with('"'));
    let v: serde_json::Value = serde_json::from_slice(&ok.body).unwrap();
    assert_eq!(v["alerts"][0]["id"], "a");

    let not_modified = cached(service_alerts(&ctx, Some(&etag)));
    assert_eq!(not_modified.status, 304);
    assert!(not_modified.body.is_empty());
    assert_eq!(not_modified.etag.as_deref(), Some(etag.as_str()));
    assert_eq!(not_modified.cache_control, "no-cache");

    let stale_etag = cached(service_alerts(&ctx, Some("\"other\"")));
    assert_eq!(stale_etag.status, 200);

    // /health/rt reports the alert feed on its own.
    let Resp::Json { status, body } = rt_health(&ctx) else {
        panic!("expected Resp::Json");
    };
    assert_eq!(status, 503, "TripUpdates are not configured");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["overall"], "disabled");
    assert_eq!(v["serviceAlerts"]["overall"], "ok");
    assert_eq!(v["serviceAlerts"]["feeds"][0]["entryCount"], 1);
    assert_eq!(v["serviceAlerts"]["served"], 1);
}

#[test]
fn rt_health_without_alert_feeds_is_unchanged() {
    let (_dir, ctx) = ctx_with_alerts("");
    let Resp::Json { status, body } = rt_health(&ctx) else {
        panic!("expected Resp::Json");
    };
    assert_eq!(status, 503);
    assert_eq!(body, r#"{"overall":"disabled","feeds":[]}"#);
}

#[test]
fn alerts_route_is_served_on_the_public_listener_only() {
    assert_eq!(
        resolve(
            "GET",
            "/api/vilnius/alerts",
            "vilnius",
            ListenerKind::Public
        ),
        Route::ServiceAlerts
    );
    for listener in [ListenerKind::Loopback, ListenerKind::Auxiliary] {
        assert_eq!(
            resolve("GET", "/api/vilnius/alerts", "vilnius", listener),
            Route::NotFound
        );
    }
}

// ---------------------------------------------------------------------------
// X-PT-Realtime on /gtfs/manifest
// ---------------------------------------------------------------------------

const ANCHOR: u64 = 1779494400;

/// A generation with a schedule-tile manifest, and a ctx built from
/// `configure`d config (same harness as tests/gtfs_manifest.rs).
fn manifest_ctx(
    configure: impl FnOnce(&mut pt_serve::ServerConfig),
) -> (tempfile::TempDir, Arc<ServerCtx>) {
    let (dir, _config, _clock) = common::isolated_config();
    let data_root = dir.path().to_path_buf();
    let created_at = publisher::rfc3339_format(ANCHOR);
    let gen_id =
        publisher::publish_generation(&data_root, "vilnius", &common::tiny_ptb_path(), &created_at);
    let gen_dir = data_root.join("generations").join(&gen_id);
    write_manifest(&gen_dir, &gen_id);
    let manifest_text = std::fs::read_to_string(publisher::manifest_path_for(&data_root, &gen_id))
        .expect("read manifest");
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let metrics = Arc::new(Metrics::default());
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let gen: Generation = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(&data_root, &gen_id),
        transfers_path: None,
        expected_city: "vilnius",
        clock: &clock,
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("build generation");
    let mut cfg = common::default_test_config(data_root);
    configure(&mut cfg);
    let ctx = ServerCtx::new(gen, cfg, metrics);
    (dir, ctx)
}

fn write_manifest(gen_dir: &Path, gen_id: &str) {
    let st_dir = gen_dir.join("schedule-tiles");
    std::fs::create_dir_all(&st_dir).unwrap();
    std::fs::write(
        st_dir.join("manifest.json"),
        format!(
            "{{\n  \"schemaVersion\": 1,\n  \"bundleHash\": \"{gen_id}\",\n  \"generatedAt\": 1752300000000,\n  \"tileSize\": 6000\n}}"
        ),
    )
    .unwrap();
}

/// (status, body bytes, etag, X-PT-Realtime) of a manifest reply as sent.
fn sent(resp: Resp) -> (u16, Vec<u8>, Option<String>, Option<String>) {
    let tiny = pt_serve::http::adapter::to_tiny_http(resp);
    let header = |name: &str| {
        tiny.headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str().to_string())
    };
    let realtime = header("X-PT-Realtime");
    let etag = header("ETag");
    let status = tiny.status_code().0;
    let mut body = Vec::new();
    tiny.into_reader().read_to_end(&mut body).unwrap();
    (status, body, etag, realtime)
}

use std::io::Read as _;

fn manifest_parts(resp: &Resp) -> (u16, Vec<u8>, Option<String>) {
    match resp {
        Resp::WithBundleHash {
            status, body, etag, ..
        } => (
            *status,
            body.as_ref()
                .map(|b| match b {
                    ByteBody::Raw(r) => r.to_vec(),
                    _ => panic!("expected a raw body"),
                })
                .unwrap_or_default(),
            etag.clone(),
        ),
        _ => panic!("expected Resp::WithBundleHash"),
    }
}

#[test]
fn manifest_header_follows_feed_configuration() {
    let cases: [(&str, &str, &str); 4] = [
        ("", "", ""),
        ("http://a.test/tu.pb", "", "departures"),
        ("", "http://a.test/al.pb", "alerts"),
        (
            "http://a.test/tu.pb",
            "http://a.test/al.pb",
            "departures, alerts",
        ),
    ];
    for (trip_updates, alerts, want) in cases {
        let (_dir, ctx) = manifest_ctx(|c| {
            c.rt_trip_updates_urls = trip_updates.to_string();
            c.rt_service_alerts_urls = alerts.to_string();
        });
        assert_eq!(&*ctx.realtime_header, want);
        let gen = ctx.current_generation();

        // 200: the header is added; body and ETag are exactly today's.
        let (base_status, base_body, base_etag) = manifest_parts(&gtfs_manifest(&gen, None));
        assert_eq!(base_status, 200);
        let (status, body, etag, realtime) = sent(gtfs_manifest_with_realtime(
            &gen,
            None,
            &ctx.realtime_header,
        ));
        assert_eq!(status, 200);
        assert_eq!(body, base_body, "body unchanged");
        assert_eq!(etag, base_etag, "ETag unchanged");
        assert_eq!(realtime.as_deref(), Some(want), "200 for {want:?}");

        // 304 carries it too.
        let (status, body, etag304, realtime) = sent(gtfs_manifest_with_realtime(
            &gen,
            base_etag.as_deref(),
            &ctx.realtime_header,
        ));
        assert_eq!(status, 304);
        assert!(body.is_empty());
        assert_eq!(etag304, base_etag);
        assert_eq!(realtime.as_deref(), Some(want), "304 for {want:?}");
    }
}

#[test]
fn manifest_503_carries_no_realtime_header() {
    let (_dir, ctx) = ctx_with_alerts("http://a.test/al.pb");
    let gen = ctx.current_generation();
    let (status, _, _, realtime) = sent(gtfs_manifest_with_realtime(
        &gen,
        None,
        &ctx.realtime_header,
    ));
    assert_eq!(status, 503);
    assert_eq!(realtime, None);
}
