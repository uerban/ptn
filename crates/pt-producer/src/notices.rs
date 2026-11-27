//! Editor-approved service notices → the `service-notices.json` artifact.
//!
//! Input is a city's notices file in the feed-catalog format (local wall
//! times in the city zone; validated upstream against the prepared feeds).
//! Output is the schema-v1 body of `packages/shared/src/types/serviceNotices.ts`:
//! every notice resolved to half-open UTC windows, so clients compare instants
//! only. The conversion is a pure function of the input bytes and the zone, so
//! the artifact is byte-stable and its input hash alone identifies it.
//!
//! Time rules: a date-only range covers whole local days with an inclusive
//! `to`; a datetime range ends exclusive; a local time inside a DST gap is
//! rejected; one inside a DST fold resolves to its first occurrence. Ended
//! notices are kept (dropping them would make the bytes depend on the clock);
//! clients ignore windows in the past.

use std::collections::BTreeMap;
use std::path::Path;

use jiff::civil::{Date, DateTime};
use jiff::tz::{AmbiguousOffset, TimeZone};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// `ServiceNoticesBody.schemaVersion`.
pub const SERVICE_NOTICES_SCHEMA_VERSION: u32 = 1;
/// File name inside a generation directory.
pub const SERVICE_NOTICES_FILENAME: &str = "service-notices.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    notices: Vec<SourceNotice>,
    /// Detector-only suppressions; never published.
    #[serde(default)]
    #[allow(dead_code)]
    ignore: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceNotice {
    id: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    routes: Option<Vec<String>>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    kind: String,
    #[serde(default)]
    free: Option<bool>,
    #[serde(default)]
    events: Option<Vec<String>>,
    #[serde(default)]
    text: Option<BTreeMap<String, String>>,
    #[serde(default)]
    icon: Option<String>,
    source: String,
}

#[derive(Serialize)]
struct Body {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    notices: Vec<Notice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Notice {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    route_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    city: Option<bool>,
    kind: String,
    free: bool,
    windows: Vec<Window>,
    display_until: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    source: String,
}

#[derive(Serialize)]
struct Window {
    start: String,
    end: String,
}

fn invalid(id: &str, message: impl std::fmt::Display) -> Error {
    Error::Config(format!("service notice {id}: {message}"))
}

fn parse_date(id: &str, value: &str) -> Result<Date> {
    if value.len() != 10 {
        return Err(invalid(id, format!("bad date {value:?}")));
    }
    value
        .parse::<Date>()
        .map_err(|e| invalid(id, format!("bad date {value:?}: {e}")))
}

fn parse_datetime(id: &str, value: &str) -> Result<DateTime> {
    if value.len() != 16 || value.as_bytes()[10] != b'T' {
        return Err(invalid(id, format!("bad datetime {value:?}")));
    }
    value
        .parse::<DateTime>()
        .map_err(|e| invalid(id, format!("bad datetime {value:?}: {e}")))
}

/// A local wall time as a UTC instant string; DST gaps are rejected.
fn instant(id: &str, zone: &TimeZone, local: DateTime) -> Result<String> {
    let ambiguous = zone.to_ambiguous_zoned(local);
    if let AmbiguousOffset::Gap { .. } = ambiguous.offset() {
        return Err(invalid(
            id,
            format!("local time {local} does not exist in the city zone"),
        ));
    }
    let zoned = ambiguous
        .earlier()
        .map_err(|e| invalid(id, format!("cannot resolve {local}: {e}")))?;
    Ok(zoned.timestamp().strftime("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn day_window(id: &str, zone: &TimeZone, first: Date, last: Date) -> Result<Window> {
    let end = last
        .tomorrow()
        .map_err(|e| invalid(id, format!("date out of range: {e}")))?;
    Ok(Window {
        start: instant(id, zone, first.to_datetime(jiff::civil::Time::midnight()))?,
        end: instant(id, zone, end.to_datetime(jiff::civil::Time::midnight()))?,
    })
}

/// A short non-ASCII badge (one emoji, possibly with modifiers); 16 bytes
/// covers ZWJ pairs without admitting words.
fn is_icon(icon: &str) -> bool {
    !icon.is_empty() && icon.len() <= 16 && !icon.chars().any(|c| c.is_ascii() || c.is_whitespace())
}

fn convert(notice: SourceNotice, zone: &TimeZone) -> Result<Notice> {
    let id = notice.id.as_str();
    let (route_ids, city) = match (notice.scope.as_deref(), notice.routes) {
        (Some("city"), None) => (None, Some(true)),
        (None, Some(routes)) if !routes.is_empty() => (Some(routes), None),
        _ => return Err(invalid(id, "needs exactly one of scope \"city\" or routes")),
    };
    if !matches!(notice.kind.as_str(), "seasonal" | "event" | "free") {
        return Err(invalid(id, format!("unknown kind {:?}", notice.kind)));
    }
    if let Some(icon) = &notice.icon {
        if !is_icon(icon) {
            return Err(invalid(id, format!("icon {icon:?} must be one emoji")));
        }
    }
    if !notice.source.starts_with("https://") {
        return Err(invalid(id, "source must be an https URL"));
    }
    let (windows, display_until) =
        match (notice.from.as_deref(), notice.to.as_deref(), notice.events) {
            (None, None, Some(days)) if notice.kind == "event" && !days.is_empty() => {
                let mut dates = days
                    .iter()
                    .map(|d| parse_date(id, d))
                    .collect::<Result<Vec<_>>>()?;
                dates.sort();
                if dates.windows(2).any(|pair| pair[0] == pair[1]) {
                    return Err(invalid(id, "duplicate event date"));
                }
                let windows = dates
                    .iter()
                    .map(|day| day_window(id, zone, *day, *day))
                    .collect::<Result<Vec<_>>>()?;
                (windows, *dates.last().expect("non-empty"))
            }
            (Some(from), Some(to), None) if from.len() == 10 && to.len() == 10 => {
                let (first, last) = (parse_date(id, from)?, parse_date(id, to)?);
                if first > last {
                    return Err(invalid(id, format!("from {from} is after to {to}")));
                }
                (vec![day_window(id, zone, first, last)?], last)
            }
            (Some(from), Some(to), None) => {
                let (begin, finish) = (parse_datetime(id, from)?, parse_datetime(id, to)?);
                let window = Window {
                    start: instant(id, zone, begin)?,
                    end: instant(id, zone, finish)?,
                };
                if window.start >= window.end {
                    return Err(invalid(id, format!("from {from} is not before to {to}")));
                }
                // Inclusive last local day: the day of the last instant inside the window.
                let last_inside = finish
                    .checked_sub(jiff::Span::new().seconds(1))
                    .map_err(|e| invalid(id, e))?;
                (vec![window], last_inside.date())
            }
            _ => {
                return Err(invalid(
                    id,
                    "needs from and to, or events on kind \"event\"",
                ))
            }
        };
    Ok(Notice {
        id: notice.id,
        route_ids,
        city,
        kind: notice.kind,
        free: notice.free.unwrap_or(false),
        windows,
        display_until: display_until.to_string(),
        text: notice.text,
        icon: notice.icon,
        source: notice.source,
    })
}

/// Convert source bytes (the catalog's `notices/<city>.json`) into artifact bytes.
pub fn build_service_notices(source: &[u8], city_tz_iana: &str) -> Result<Vec<u8>> {
    let zone = TimeZone::get(city_tz_iana)
        .map_err(|e| Error::Config(format!("service notices: unknown zone {city_tz_iana}: {e}")))?;
    let file: SourceFile = serde_json::from_slice(source)
        .map_err(|e| Error::Config(format!("service notices: invalid file: {e}")))?;
    let mut seen = std::collections::BTreeSet::new();
    let mut notices = Vec::with_capacity(file.notices.len());
    for notice in file.notices {
        if !seen.insert(notice.id.clone()) {
            return Err(invalid(&notice.id, "duplicate id"));
        }
        notices.push(convert(notice, &zone)?);
    }
    let body = Body {
        schema_version: SERVICE_NOTICES_SCHEMA_VERSION,
        notices,
    };
    let mut bytes = serde_json::to_vec(&body).map_err(|e| Error::Config(e.to_string()))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Read, convert and stage the artifact; returns its SHA-256 (lowercase hex).
pub fn stage_service_notices(
    source: &Path,
    city_tz_iana: &str,
    staging_dir: &Path,
) -> Result<String> {
    let bytes = build_service_notices(&std::fs::read(source)?, city_tz_iana)?;
    let dest = staging_dir.join(SERVICE_NOTICES_FILENAME);
    std::fs::write(&dest, &bytes)?;
    std::fs::File::open(&dest)?.sync_all()?;
    Ok(crate::build::sha256_hex(&std::fs::read(&dest)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const ZONE: &str = "Europe/Vilnius";
    const SOURCE: &str = "https://example.org/notice";

    fn build(notices: Value) -> Result<Value> {
        let bytes = build_service_notices(
            serde_json::to_vec(&json!({ "notices": notices }))
                .unwrap()
                .as_slice(),
            ZONE,
        )?;
        Ok(serde_json::from_slice(&bytes).unwrap())
    }

    fn one(notice: Value) -> Value {
        build(json!([notice])).unwrap()["notices"][0].clone()
    }

    #[test]
    fn a_date_range_covers_whole_local_days_with_an_inclusive_end() {
        let notice = one(
            json!({"id": "bus", "routes": ["vilnius_bus_201"], "from": "2026-11-28",
                                "to": "2026-12-31", "kind": "seasonal", "free": true, "source": SOURCE}),
        );
        assert_eq!(
            notice,
            json!({"id": "bus", "routeIds": ["vilnius_bus_201"], "kind": "seasonal", "free": true,
                   "windows": [{"start": "2026-11-27T22:00:00Z", "end": "2026-12-31T22:00:00Z"}],
                   "displayUntil": "2026-12-31", "source": SOURCE})
        );
    }

    #[test]
    fn a_datetime_range_ends_exclusive_and_city_scope_is_flagged() {
        let notice = one(
            json!({"id": "tree", "scope": "city", "from": "2026-11-28T15:00",
                                "to": "2026-11-29T00:00", "kind": "free", "free": true, "source": SOURCE}),
        );
        assert_eq!(notice["city"], json!(true));
        assert!(notice.get("routeIds").is_none());
        assert_eq!(
            notice["windows"],
            json!([{"start": "2026-11-28T13:00:00Z", "end": "2026-11-28T22:00:00Z"}])
        );
        assert_eq!(notice["displayUntil"], json!("2026-11-28"));
    }

    #[test]
    fn events_expand_into_sorted_day_windows_and_free_defaults_to_false() {
        let notice = one(json!({"id": "choir", "routes": ["r"], "kind": "event",
                                "events": ["2026-12-14", "2026-12-03"], "source": SOURCE}));
        assert_eq!(notice["free"], json!(false));
        assert_eq!(
            notice["windows"],
            json!([{"start": "2026-12-02T22:00:00Z", "end": "2026-12-03T22:00:00Z"},
                   {"start": "2026-12-13T22:00:00Z", "end": "2026-12-14T22:00:00Z"}])
        );
        assert_eq!(notice["displayUntil"], json!("2026-12-14"));
    }

    #[test]
    fn a_timed_event_uses_its_window() {
        let notice = one(
            json!({"id": "choir-1g", "routes": ["r"], "kind": "event", "from": "2026-12-03T18:00",
                                "to": "2026-12-03T19:27", "text": {"lt": "Choras"}, "source": SOURCE}),
        );
        assert_eq!(
            notice["windows"],
            json!([{"start": "2026-12-03T16:00:00Z", "end": "2026-12-03T17:27:00Z"}])
        );
        assert_eq!(notice["text"], json!({"lt": "Choras"}));
    }

    #[test]
    fn an_icon_is_carried_and_must_be_an_emoji() {
        let notice = |icon: Value| {
            build(
                json!([{"id": "bus", "routes": ["r"], "from": "2026-11-28", "to": "2026-12-31",
                          "kind": "seasonal", "icon": icon, "source": SOURCE}]),
            )
        };
        assert_eq!(
            notice(json!("🎄")).unwrap()["notices"][0]["icon"],
            json!("🎄")
        );
        for bad in [
            json!(""),
            json!("X"),
            json!("🎄 bus"),
            json!("🎄🎄🎄🎄🎄"),
            json!(1),
        ] {
            assert!(notice(bad.clone()).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn dst_gap_is_rejected_and_fold_takes_the_first_occurrence() {
        let gap = build(
            json!([{"id": "gap", "scope": "city", "from": "2027-03-28T03:30",
                                "to": "2027-03-28T05:00", "kind": "free", "source": SOURCE}]),
        );
        assert!(gap.unwrap_err().to_string().contains("does not exist"));
        let fold = one(
            json!({"id": "fold", "scope": "city", "from": "2027-10-31T03:30",
                              "to": "2027-10-31T05:00", "kind": "free", "source": SOURCE}),
        );
        // 03:30 happens at +03:00 first, then at +02:00.
        assert_eq!(fold["windows"][0]["start"], json!("2027-10-31T00:30:00Z"));
        // A whole spring-forward day is 23 hours.
        let day = one(
            json!({"id": "day", "scope": "city", "from": "2027-03-28", "to": "2027-03-28",
                             "kind": "free", "source": SOURCE}),
        );
        assert_eq!(
            day["windows"],
            json!([{"start": "2027-03-27T22:00:00Z", "end": "2027-03-28T21:00:00Z"}])
        );
    }

    #[test]
    fn output_is_byte_stable_and_ignore_entries_are_not_published() {
        let source = serde_json::to_vec(&json!({
            "notices": [{"id": "a", "scope": "city", "from": "2026-12-01", "to": "2026-12-01",
                         "kind": "free", "source": SOURCE}],
            "ignore": [{"route": "r", "until": "2027-01-01"}]
        }))
        .unwrap();
        let first = build_service_notices(&source, ZONE).unwrap();
        assert_eq!(first, build_service_notices(&source, ZONE).unwrap());
        let text = String::from_utf8(first).unwrap();
        assert!(text.starts_with("{\"schemaVersion\":1,\"notices\":["));
        assert!(!text.contains("ignore") && text.ends_with('\n'));
    }

    #[test]
    fn malformed_notices_fail_the_publication() {
        let base = json!({"id": "x", "scope": "city", "from": "2026-12-01", "to": "2026-12-02",
                          "kind": "free", "source": SOURCE});
        let mut cases = Vec::new();
        for (key, value) in [
            ("routes", json!(["r"])),
            ("kind", json!("holiday")),
            ("source", json!("http://example.org")),
            ("to", json!("2026-12-02T10:00")),
            ("from", json!("2026-12-03")),
            ("colour", json!("red")),
            ("events", json!(["2026-12-01"])),
        ] {
            let mut notice = base.clone();
            notice[key] = value;
            cases.push(json!([notice]));
        }
        cases.push(json!([base.clone(), base.clone()]));
        for case in cases {
            assert!(build(case.clone()).is_err(), "accepted {case}");
        }
        assert!(build_service_notices(b"{\"notices\": [], \"extra\": 1}", ZONE).is_err());
        assert!(build_service_notices(b"{\"notices\": []}", "Not/AZone").is_err());
    }

    #[test]
    fn the_body_has_the_shared_contract_fields() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../packages/shared/src/types/__fixtures__/service-notices.json"
        ))
        .unwrap();
        let ours = build(json!([
            {"id": "vilnius-2026-christmas-bus", "routes": ["vilnius_bus_201"], "from": "2026-11-28",
             "to": "2026-12-31", "kind": "seasonal", "free": true, "text": {"lt": "Nemokamas Kalėdinis autobusas"},
             "icon": "🎄", "source": "https://example.org/christmas-bus"}
        ]))
        .unwrap();
        assert_eq!(ours["schemaVersion"], golden["schemaVersion"]);
        assert_eq!(ours["notices"][0], golden["notices"][0]);
    }
}
