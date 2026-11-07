// crates/pt-serve/src/rt/alerts.rs

//! Decodes the GTFS-RT ServiceAlerts subtree (`FeedEntity.alert`, field 5)
//! into [`ServiceAlert`]s, on the same hand-rolled wire reader the
//! TripUpdates parser uses (`rt::protobuf`).
//!
//! The upstream feed is untrusted. Everything kept from it is bounded:
//! - at most [`MAX_ALERTS_PER_FEED`] alerts, and at most
//!   [`MAX_FEED_TEXT_BYTES`] of kept strings per feed; alerts past either
//!   limit are dropped and counted;
//! - per alert: [`MAX_TRANSLATIONS`] translations per text,
//!   [`MAX_ACTIVE_PERIODS`] periods and [`MAX_INFORMED_ENTITIES`] selectors;
//! - texts are cut at [`MAX_HEADER_CHARS`] / [`MAX_DESCRIPTION_CHARS`]
//!   characters, control characters (and bidirectional overrides) are
//!   removed, and only `http`/`https` URLs are kept. Texts are plain text:
//!   nothing here interprets markup, and clients must render them as text.
//!
//! A body that is not valid protobuf, or that lacks a field protobufjs
//! requires (`FeedHeader.gtfs_realtime_version`, `FeedEntity.id`,
//! `Translation.text`), fails as a whole, like a TripUpdates feed: the poller
//! keeps the feed's last good alerts. Only `FULL_DATASET` feeds are accepted;
//! a `DIFFERENTIAL` feed fails the same way.
//!
//! IDs are kept verbatim here. Matching them against the served bundle is
//! `rt::alerts_state`'s job.
//!
//! GTFS-Realtime reference: <https://gtfs.org/documentation/realtime/reference/#message-alert>

use crate::rt::poller::FeedPayload;
use crate::rt::protobuf::Reader;
use std::collections::HashMap;

/// Alerts kept per feed. Real feeds publish tens; a thousand is far beyond
/// any city's disruption list.
pub const MAX_ALERTS_PER_FEED: usize = 1000;
/// Bytes of kept strings (ids, texts, language tags) per feed. Bounds the
/// memory a feed can occupy whatever its shape.
pub const MAX_FEED_TEXT_BYTES: usize = 1024 * 1024;
/// Translations kept per translated text.
pub const MAX_TRANSLATIONS: usize = 16;
/// Characters kept of a header text translation.
pub const MAX_HEADER_CHARS: usize = 512;
/// Characters kept of a description text translation.
pub const MAX_DESCRIPTION_CHARS: usize = 4096;
/// Longest URL kept. Longer ones are dropped, not cut: a cut URL is broken.
pub const MAX_URL_CHARS: usize = 2048;
/// Longest feed id (alert, agency, route, trip, stop) accepted.
pub const MAX_ID_BYTES: usize = 256;
/// Active periods kept per alert.
pub const MAX_ACTIVE_PERIODS: usize = 64;
/// Informed entities kept per alert.
pub const MAX_INFORMED_ENTITIES: usize = 256;
/// Longest BCP-47 language tag accepted.
const MAX_LANGUAGE_BYTES: usize = 35;

/// GTFS-RT `Alert.Cause`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    UnknownCause,
    OtherCause,
    TechnicalProblem,
    Strike,
    Demonstration,
    Accident,
    Holiday,
    Weather,
    Maintenance,
    Construction,
    PoliceActivity,
    MedicalEmergency,
}

impl Cause {
    /// Enum value to cause; values this decoder does not know read as
    /// `UNKNOWN_CAUSE`, the field's default.
    pub fn from_code(code: u64) -> Self {
        match code {
            2 => Self::OtherCause,
            3 => Self::TechnicalProblem,
            4 => Self::Strike,
            5 => Self::Demonstration,
            6 => Self::Accident,
            7 => Self::Holiday,
            8 => Self::Weather,
            9 => Self::Maintenance,
            10 => Self::Construction,
            11 => Self::PoliceActivity,
            12 => Self::MedicalEmergency,
            _ => Self::UnknownCause,
        }
    }

    /// The GTFS-RT enum name, as served.
    pub fn name(self) -> &'static str {
        match self {
            Self::UnknownCause => "UNKNOWN_CAUSE",
            Self::OtherCause => "OTHER_CAUSE",
            Self::TechnicalProblem => "TECHNICAL_PROBLEM",
            Self::Strike => "STRIKE",
            Self::Demonstration => "DEMONSTRATION",
            Self::Accident => "ACCIDENT",
            Self::Holiday => "HOLIDAY",
            Self::Weather => "WEATHER",
            Self::Maintenance => "MAINTENANCE",
            Self::Construction => "CONSTRUCTION",
            Self::PoliceActivity => "POLICE_ACTIVITY",
            Self::MedicalEmergency => "MEDICAL_EMERGENCY",
        }
    }
}

/// GTFS-RT `Alert.Effect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    NoService,
    ReducedService,
    SignificantDelays,
    Detour,
    AdditionalService,
    ModifiedService,
    OtherEffect,
    UnknownEffect,
    StopMoved,
    NoEffect,
    AccessibilityIssue,
}

impl Effect {
    /// Enum value to effect; unknown values read as `UNKNOWN_EFFECT`, the
    /// field's default.
    pub fn from_code(code: u64) -> Self {
        match code {
            1 => Self::NoService,
            2 => Self::ReducedService,
            3 => Self::SignificantDelays,
            4 => Self::Detour,
            5 => Self::AdditionalService,
            6 => Self::ModifiedService,
            7 => Self::OtherEffect,
            9 => Self::StopMoved,
            10 => Self::NoEffect,
            11 => Self::AccessibilityIssue,
            _ => Self::UnknownEffect,
        }
    }

    /// The GTFS-RT enum name, as served.
    pub fn name(self) -> &'static str {
        match self {
            Self::NoService => "NO_SERVICE",
            Self::ReducedService => "REDUCED_SERVICE",
            Self::SignificantDelays => "SIGNIFICANT_DELAYS",
            Self::Detour => "DETOUR",
            Self::AdditionalService => "ADDITIONAL_SERVICE",
            Self::ModifiedService => "MODIFIED_SERVICE",
            Self::OtherEffect => "OTHER_EFFECT",
            Self::UnknownEffect => "UNKNOWN_EFFECT",
            Self::StopMoved => "STOP_MOVED",
            Self::NoEffect => "NO_EFFECT",
            Self::AccessibilityIssue => "ACCESSIBILITY_ISSUE",
        }
    }
}

/// GTFS-RT `Alert.SeverityLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Unknown,
    Info,
    Warning,
    Severe,
}

impl Severity {
    /// Enum value to severity; `UNKNOWN_SEVERITY` and unknown values read as
    /// `UNKNOWN`.
    pub fn from_code(code: u64) -> Self {
        match code {
            2 => Self::Info,
            3 => Self::Warning,
            4 => Self::Severe,
            _ => Self::Unknown,
        }
    }

    /// The served name (`UNKNOWN_SEVERITY` is served as `UNKNOWN`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Unknown => "UNKNOWN",
            Self::Info => "INFO",
            Self::Warning => "WARNING",
            Self::Severe => "SEVERE",
        }
    }
}

/// One translation of a `TranslatedString`, sanitised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Translation {
    /// BCP-47 tag; `None` when absent or not a plausible tag.
    pub language: Option<Box<str>>,
    pub text: Box<str>,
}

/// A `TimeRange`, POSIX seconds. `None` is an open end (a `0` on the wire
/// reads as absent too).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivePeriod {
    pub start: Option<u64>,
    pub end: Option<u64>,
}

impl ActivePeriod {
    /// True once the period has ended at `now_secs`.
    pub fn ended_by(&self, now_secs: u64) -> bool {
        matches!(self.end, Some(end) if end <= now_secs)
    }
}

/// An `EntitySelector`, flattened: `trip.trip_id` becomes `trip_id`, and
/// `trip.route_id` / `trip.direction_id` fill `route_id` / `direction_id`
/// when the selector does not set them itself. Always carries at least one
/// field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntitySelector {
    pub agency_id: Option<Box<str>>,
    pub route_id: Option<Box<str>>,
    pub route_type: Option<i32>,
    pub direction_id: Option<u32>,
    pub trip_id: Option<Box<str>>,
    pub stop_id: Option<Box<str>>,
}

impl EntitySelector {
    fn is_empty(&self) -> bool {
        self.agency_id.is_none()
            && self.route_id.is_none()
            && self.route_type.is_none()
            && self.direction_id.is_none()
            && self.trip_id.is_none()
            && self.stop_id.is_none()
    }

    fn text_bytes(&self) -> usize {
        [
            &self.agency_id,
            &self.route_id,
            &self.trip_id,
            &self.stop_id,
        ]
        .iter()
        .map(|s| s.as_deref().map_or(0, str::len))
        .sum()
    }
}

/// One decoded alert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceAlert {
    /// The feed entity id.
    pub id: Box<str>,
    pub cause: Cause,
    pub effect: Effect,
    pub severity: Severity,
    pub header: Vec<Translation>,
    pub description: Vec<Translation>,
    pub url: Vec<Translation>,
    /// Empty means always active.
    pub active_periods: Vec<ActivePeriod>,
    pub informed_entities: Vec<EntitySelector>,
}

impl ServiceAlert {
    /// True when every active period has ended by `now_secs`. An alert
    /// without periods is always active.
    pub fn expired_by(&self, now_secs: u64) -> bool {
        !self.active_periods.is_empty() && self.active_periods.iter().all(|p| p.ended_by(now_secs))
    }

    fn text_bytes(&self) -> usize {
        let texts: usize = [&self.header, &self.description, &self.url]
            .iter()
            .flat_map(|t| t.iter())
            .map(|t| t.text.len() + t.language.as_deref().map_or(0, str::len))
            .sum();
        let selectors: usize = self
            .informed_entities
            .iter()
            .map(EntitySelector::text_bytes)
            .sum();
        self.id.len() + texts + selectors
    }
}

/// What one ServiceAlerts feed body decodes into.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedAlerts {
    /// Kept alerts, in feed order; ids are unique (a later duplicate wins).
    pub alerts: Vec<ServiceAlert>,
    /// Alerts dropped while decoding: over a cap, without an id, or without
    /// a usable informed entity.
    pub dropped_alerts: u32,
    /// Selectors dropped while decoding: empty, or carrying an id or
    /// direction no bundle can hold.
    pub dropped_selectors: u32,
}

impl FeedPayload for FeedAlerts {
    fn parse(bytes: &[u8]) -> std::result::Result<Self, String> {
        parse_alerts_buffer(bytes).map_err(|e| match e {
            AlertsParseError::Malformed => "malformed GTFS-RT feed".to_string(),
            AlertsParseError::Differential => {
                "DIFFERENTIAL GTFS-RT feeds are not supported".to_string()
            }
        })
    }

    fn entry_count(&self) -> usize {
        self.alerts.len()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AlertsParseError {
    /// Not valid protobuf, or a field protobufjs requires is missing.
    Malformed,
    /// `FeedHeader.incrementality` is `DIFFERENTIAL`.
    Differential,
}

type Result<T> = std::result::Result<T, AlertsParseError>;

/// Decode a ServiceAlerts `FeedMessage`. Entities that are not alerts are
/// skipped, as are entities marked `is_deleted`.
pub fn parse_alerts_buffer(data: &[u8]) -> Result<FeedAlerts> {
    let mut saw_header = false;
    let mut out = FeedAlerts::default();
    // id -> index in `out.alerts`, so a duplicate id replaces in place.
    let mut index_by_id: HashMap<Box<str>, usize> = HashMap::new();
    let mut text_bytes = 0usize;
    let mut r = Reader::new(data);
    while !r.is_empty() {
        let (field, wire_type) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wire_type) {
            (1, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                parse_feed_header(bytes)?;
                saw_header = true;
            }
            (2, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                let Some(decoded) = parse_entity(bytes, &mut out.dropped_selectors)? else {
                    continue;
                };
                let Some(alert) = decoded else {
                    out.dropped_alerts += 1;
                    continue;
                };
                let size = alert.text_bytes();
                if let Some(&i) = index_by_id.get(&alert.id) {
                    let previous = out.alerts[i].text_bytes();
                    let next_total = text_bytes - previous + size;
                    if next_total > MAX_FEED_TEXT_BYTES {
                        out.dropped_alerts += 1;
                        continue;
                    }
                    text_bytes = next_total;
                    out.alerts[i] = alert;
                    continue;
                }
                if out.alerts.len() >= MAX_ALERTS_PER_FEED
                    || text_bytes + size > MAX_FEED_TEXT_BYTES
                {
                    out.dropped_alerts += 1;
                    continue;
                }
                text_bytes += size;
                index_by_id.insert(alert.id.clone(), out.alerts.len());
                out.alerts.push(alert);
            }
            _ => r.skip_field(wire_type).ok_or(AlertsParseError::Malformed)?,
        }
    }
    if !saw_header {
        return Err(AlertsParseError::Malformed);
    }
    Ok(out)
}

/// `FeedHeader`: `gtfs_realtime_version` (1, required), `incrementality`
/// (2: `FULL_DATASET` 0, `DIFFERENTIAL` 1).
fn parse_feed_header(buf: &[u8]) -> Result<()> {
    let mut saw_version = false;
    let mut differential = false;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                r.read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                saw_version = true;
            }
            (2, 0) => {
                differential = r.read_varint().ok_or(AlertsParseError::Malformed)? == 1;
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    if !saw_version {
        return Err(AlertsParseError::Malformed);
    }
    if differential {
        return Err(AlertsParseError::Differential);
    }
    Ok(())
}

/// `FeedEntity`: `id` (1, required), `is_deleted` (2), `alert` (5).
///
/// `Ok(None)`: not an alert entity, or deleted — skipped, not counted.
/// `Ok(Some(None))`: an alert that cannot be kept — counted as dropped.
fn parse_entity(buf: &[u8], dropped_selectors: &mut u32) -> Result<Option<Option<ServiceAlert>>> {
    let mut id: Option<&[u8]> = None;
    let mut is_deleted = false;
    let mut alert: Option<RawAlert> = None;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                id = Some(
                    r.read_length_delimited()
                        .ok_or(AlertsParseError::Malformed)?,
                )
            }
            (2, 0) => is_deleted = r.read_varint().ok_or(AlertsParseError::Malformed)? != 0,
            (5, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                // Decode every occurrence: protobufjs rejects a malformed
                // message even when a later duplicate would replace it.
                alert = Some(parse_alert(bytes, dropped_selectors)?);
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    let Some(id) = id else {
        return Err(AlertsParseError::Malformed);
    };
    let Some(raw) = alert else {
        return Ok(None);
    };
    if is_deleted {
        return Ok(None);
    }
    let Some(id) = sanitize_id(id) else {
        return Ok(Some(None));
    };
    if raw.informed_entities.is_empty() {
        // The spec requires at least one; an alert that names nothing it
        // applies to cannot be shown anywhere.
        return Ok(Some(None));
    }
    Ok(Some(Some(ServiceAlert {
        id,
        cause: raw.cause,
        effect: raw.effect,
        severity: raw.severity,
        header: raw.header,
        description: raw.description,
        url: raw.url,
        active_periods: raw.active_periods,
        informed_entities: raw.informed_entities,
    })))
}

struct RawAlert {
    cause: Cause,
    effect: Effect,
    severity: Severity,
    header: Vec<Translation>,
    description: Vec<Translation>,
    url: Vec<Translation>,
    active_periods: Vec<ActivePeriod>,
    informed_entities: Vec<EntitySelector>,
}

/// Which sanitiser a translated text goes through.
#[derive(Clone, Copy)]
enum TextKind {
    Header,
    Description,
    Url,
}

/// `Alert`: `active_period` (1), `informed_entity` (5), `cause` (6),
/// `effect` (7), `url` (8), `header_text` (10), `description_text` (11),
/// `severity_level` (14). Text-to-speech, detail and image fields are
/// skipped.
fn parse_alert(buf: &[u8], dropped_selectors: &mut u32) -> Result<RawAlert> {
    let mut out = RawAlert {
        cause: Cause::UnknownCause,
        effect: Effect::UnknownEffect,
        severity: Severity::Unknown,
        header: Vec::new(),
        description: Vec::new(),
        url: Vec::new(),
        active_periods: Vec::new(),
        informed_entities: Vec::new(),
    };
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                let period = parse_time_range(bytes)?;
                if out.active_periods.len() < MAX_ACTIVE_PERIODS {
                    out.active_periods.push(period);
                }
            }
            (5, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                match parse_entity_selector(bytes)? {
                    Some(sel) if out.informed_entities.len() < MAX_INFORMED_ENTITIES => {
                        out.informed_entities.push(sel)
                    }
                    _ => *dropped_selectors += 1,
                }
            }
            (6, 0) => {
                out.cause = Cause::from_code(r.read_varint().ok_or(AlertsParseError::Malformed)?)
            }
            (7, 0) => {
                out.effect = Effect::from_code(r.read_varint().ok_or(AlertsParseError::Malformed)?)
            }
            (8, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                out.url = parse_translated_string(bytes, TextKind::Url)?;
            }
            (10, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                out.header = parse_translated_string(bytes, TextKind::Header)?;
            }
            (11, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                out.description = parse_translated_string(bytes, TextKind::Description)?;
            }
            (14, 0) => {
                out.severity =
                    Severity::from_code(r.read_varint().ok_or(AlertsParseError::Malformed)?)
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    Ok(out)
}

/// `TimeRange`: `start` (1), `end` (2), both uint64 POSIX seconds.
fn parse_time_range(buf: &[u8]) -> Result<ActivePeriod> {
    let mut period = ActivePeriod {
        start: None,
        end: None,
    };
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 0) => {
                period.start =
                    Some(r.read_varint().ok_or(AlertsParseError::Malformed)?).filter(|&s| s > 0)
            }
            (2, 0) => {
                period.end =
                    Some(r.read_varint().ok_or(AlertsParseError::Malformed)?).filter(|&s| s > 0)
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    Ok(period)
}

/// `EntitySelector`: `agency_id` (1), `route_id` (2), `route_type` (3),
/// `trip` (4, a `TripDescriptor`), `stop_id` (5), `direction_id` (6).
/// `Ok(None)` for a selector this server cannot use.
fn parse_entity_selector(buf: &[u8]) -> Result<Option<EntitySelector>> {
    let mut sel = EntitySelector::default();
    let mut invalid = false;
    let mut trip: Option<TripRef> = None;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                id_field(&mut sel.agency_id, &mut invalid, &mut r)?;
            }
            (2, 2) => {
                id_field(&mut sel.route_id, &mut invalid, &mut r)?;
            }
            (3, 0) => {
                // int32: sign-extended varint.
                let v = r.read_varint().ok_or(AlertsParseError::Malformed)?;
                sel.route_type = Some((v as i64) as i32);
            }
            (4, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                trip = Some(parse_trip_ref(bytes)?);
            }
            (5, 2) => {
                id_field(&mut sel.stop_id, &mut invalid, &mut r)?;
            }
            (6, 0) => {
                let v = r.read_varint().ok_or(AlertsParseError::Malformed)?;
                match u32::try_from(v) {
                    Ok(d @ (0 | 1)) => sel.direction_id = Some(d),
                    _ => invalid = true,
                }
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    if let Some(trip) = trip {
        invalid |= trip.invalid;
        if trip.trip_id.is_some() {
            sel.trip_id = trip.trip_id;
        }
        if sel.route_id.is_none() {
            sel.route_id = trip.route_id;
        }
        if sel.direction_id.is_none() {
            sel.direction_id = trip.direction_id;
        }
    }
    if invalid || sel.is_empty() {
        return Ok(None);
    }
    Ok(Some(sel))
}

/// Read one id string into `slot`, flagging the selector when the id is
/// unusable (empty ids leave the slot unset: proto2 empty means absent).
fn id_field(slot: &mut Option<Box<str>>, invalid: &mut bool, r: &mut Reader) -> Result<()> {
    let bytes = r
        .read_length_delimited()
        .ok_or(AlertsParseError::Malformed)?;
    if bytes.is_empty() {
        return Ok(());
    }
    match sanitize_id(bytes) {
        Some(id) => *slot = Some(id),
        None => *invalid = true,
    }
    Ok(())
}

/// The parts of a selector's `TripDescriptor` the selector uses.
#[derive(Default)]
struct TripRef {
    trip_id: Option<Box<str>>,
    route_id: Option<Box<str>>,
    direction_id: Option<u32>,
    invalid: bool,
}

/// `TripDescriptor`: `trip_id` (1), `route_id` (5), `direction_id` (6).
fn parse_trip_ref(buf: &[u8]) -> Result<TripRef> {
    let mut out = TripRef::default();
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => id_field(&mut out.trip_id, &mut out.invalid, &mut r)?,
            (5, 2) => id_field(&mut out.route_id, &mut out.invalid, &mut r)?,
            (6, 0) => {
                let v = r.read_varint().ok_or(AlertsParseError::Malformed)?;
                match u32::try_from(v) {
                    Ok(d @ (0 | 1)) => out.direction_id = Some(d),
                    _ => out.invalid = true,
                }
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    Ok(out)
}

/// `TranslatedString`: repeated `translation` (1), each `text` (1,
/// required) and `language` (2). Translations whose text sanitises to
/// nothing are dropped; at most [`MAX_TRANSLATIONS`] are kept.
fn parse_translated_string(buf: &[u8], kind: TextKind) -> Result<Vec<Translation>> {
    let mut out = Vec::new();
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                let bytes = r
                    .read_length_delimited()
                    .ok_or(AlertsParseError::Malformed)?;
                let translation = parse_translation(bytes, kind)?;
                if let Some(t) = translation {
                    if out.len() < MAX_TRANSLATIONS {
                        out.push(t);
                    }
                }
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    Ok(out)
}

fn parse_translation(buf: &[u8], kind: TextKind) -> Result<Option<Translation>> {
    let mut text: Option<&[u8]> = None;
    let mut language: Option<&[u8]> = None;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(AlertsParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                text = Some(
                    r.read_length_delimited()
                        .ok_or(AlertsParseError::Malformed)?,
                )
            }
            (2, 2) => {
                language = Some(
                    r.read_length_delimited()
                        .ok_or(AlertsParseError::Malformed)?,
                )
            }
            _ => r.skip_field(wt).ok_or(AlertsParseError::Malformed)?,
        }
    }
    let Some(text) = text else {
        return Err(AlertsParseError::Malformed);
    };
    let text = match kind {
        TextKind::Header => sanitize_text(text, MAX_HEADER_CHARS, false),
        TextKind::Description => sanitize_text(text, MAX_DESCRIPTION_CHARS, true),
        TextKind::Url => sanitize_url(text),
    };
    Ok(text.map(|text| Translation {
        language: language.and_then(sanitize_language),
        text: text.into_boxed_str(),
    }))
}

/// Bidirectional embedding, override and isolate controls. They are format
/// characters, not control characters, but can reorder what a reader sees.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Lossy UTF-8; line breaks normalised to `\n` (or a space when
/// `keep_newlines` is false), tabs to spaces, every other control character
/// and bidi control removed; trimmed; cut to `max_chars` characters with a
/// trailing `…`. `None` when nothing is left.
pub fn sanitize_text(raw: &[u8], max_chars: usize, keep_newlines: bool) -> Option<String> {
    let decoded = String::from_utf8_lossy(raw);
    let mut cleaned = String::with_capacity(decoded.len().min(max_chars * 4));
    let mut chars = decoded.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                cleaned.push(if keep_newlines { '\n' } else { ' ' });
            }
            '\n' => cleaned.push(if keep_newlines { '\n' } else { ' ' }),
            '\t' => cleaned.push(' '),
            c if c.is_control() || is_bidi_control(c) => {}
            c => cleaned.push(c),
        }
    }
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= max_chars {
        return Some(trimmed.to_string());
    }
    let mut cut: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    Some(cut)
}

/// An `http`/`https` URL with no whitespace or control characters, at most
/// [`MAX_URL_CHARS`] long; anything else is dropped.
fn sanitize_url(raw: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(raw).ok()?.trim();
    let lower = s.get(..8).unwrap_or(s).to_ascii_lowercase();
    let scheme_ok = lower.starts_with("https://") || lower.starts_with("http://");
    if !scheme_ok
        || s.chars().count() > MAX_URL_CHARS
        || s.chars()
            .any(|c| c.is_whitespace() || c.is_control() || is_bidi_control(c))
    {
        return None;
    }
    Some(s.to_string())
}

/// Feed ids are matched verbatim against the bundle, so they are never
/// cleaned up: an id that is not valid UTF-8, is longer than
/// [`MAX_ID_BYTES`], or carries a control character is rejected.
fn sanitize_id(raw: &[u8]) -> Option<Box<str>> {
    if raw.is_empty() || raw.len() > MAX_ID_BYTES {
        return None;
    }
    let s = std::str::from_utf8(raw).ok()?;
    if s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(s.into())
}

/// A plausible BCP-47 tag (ASCII letters, digits and `-`), or `None`.
fn sanitize_language(raw: &[u8]) -> Option<Box<str>> {
    if raw.is_empty()
        || raw.len() > MAX_LANGUAGE_BYTES
        || !raw.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-')
    {
        return None;
    }
    Some(std::str::from_utf8(raw).ok()?.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_keeps_plain_text() {
        assert_eq!(
            sanitize_text("Tram 4 diverted".as_bytes(), 100, false).as_deref(),
            Some("Tram 4 diverted")
        );
    }

    #[test]
    fn text_strips_controls_and_bidi_overrides() {
        let raw = "a\u{0007}b\u{202E}c\u{0000}d\u{2066}e";
        assert_eq!(
            sanitize_text(raw.as_bytes(), 100, true).as_deref(),
            Some("abcde")
        );
    }

    #[test]
    fn text_normalises_line_breaks() {
        let raw = "one\r\ntwo\rthree\nfour\tfive";
        assert_eq!(
            sanitize_text(raw.as_bytes(), 100, true).as_deref(),
            Some("one\ntwo\nthree\nfour five")
        );
        assert_eq!(
            sanitize_text(raw.as_bytes(), 100, false).as_deref(),
            Some("one two three four five")
        );
    }

    #[test]
    fn text_is_cut_on_a_char_boundary() {
        let cut = sanitize_text("ąčęėįšųū".as_bytes(), 5, false).unwrap();
        assert_eq!(cut, "ąčęė…");
        assert_eq!(cut.chars().count(), 5);
    }

    #[test]
    fn text_that_is_only_controls_is_none() {
        assert_eq!(sanitize_text(b"\x01\x02 \t", 10, true), None);
    }

    #[test]
    fn invalid_utf8_text_is_decoded_lossily() {
        assert_eq!(
            sanitize_text(b"ok\xffok", 10, false).as_deref(),
            Some("ok\u{FFFD}ok")
        );
    }

    #[test]
    fn urls_must_be_http_or_https() {
        assert_eq!(
            sanitize_url(b"https://example.test/a").as_deref(),
            Some("https://example.test/a")
        );
        assert_eq!(
            sanitize_url(b"HTTP://example.test/a").as_deref(),
            Some("HTTP://example.test/a")
        );
        assert_eq!(sanitize_url(b"javascript:alert(1)"), None);
        assert_eq!(sanitize_url(b"https://exa mple.test"), None);
        assert_eq!(sanitize_url(b"ftp://example.test"), None);
        let long = format!("https://example.test/{}", "a".repeat(MAX_URL_CHARS));
        assert_eq!(sanitize_url(long.as_bytes()), None);
    }

    #[test]
    fn ids_are_verbatim_or_rejected() {
        assert_eq!(sanitize_id(b" R1 ").as_deref(), Some(" R1 "));
        assert_eq!(sanitize_id(b""), None);
        assert_eq!(sanitize_id(b"a\nb"), None);
        assert_eq!(sanitize_id(b"\xff"), None);
        assert_eq!(sanitize_id(&vec![b'a'; MAX_ID_BYTES + 1]), None);
        assert!(sanitize_id(&vec![b'a'; MAX_ID_BYTES]).is_some());
    }

    #[test]
    fn languages_must_look_like_tags() {
        assert_eq!(sanitize_language(b"lt").as_deref(), Some("lt"));
        assert_eq!(sanitize_language(b"pt-BR").as_deref(), Some("pt-BR"));
        assert_eq!(sanitize_language(b"en US"), None);
        assert_eq!(sanitize_language(b"<b>"), None);
    }

    #[test]
    fn unknown_enum_values_fall_back_to_the_defaults() {
        assert_eq!(Cause::from_code(99), Cause::UnknownCause);
        assert_eq!(Effect::from_code(0), Effect::UnknownEffect);
        assert_eq!(Severity::from_code(1), Severity::Unknown);
        assert_eq!(Severity::from_code(7), Severity::Unknown);
    }

    #[test]
    fn an_alert_expires_only_when_every_period_has_ended() {
        let alert = |periods: Vec<ActivePeriod>| ServiceAlert {
            id: "a".into(),
            cause: Cause::UnknownCause,
            effect: Effect::UnknownEffect,
            severity: Severity::Unknown,
            header: vec![],
            description: vec![],
            url: vec![],
            active_periods: periods,
            informed_entities: vec![],
        };
        let p = |start, end| ActivePeriod { start, end };
        assert!(!alert(vec![]).expired_by(1_000));
        assert!(alert(vec![p(None, Some(1_000))]).expired_by(1_000));
        assert!(!alert(vec![p(None, Some(1_001))]).expired_by(1_000));
        assert!(!alert(vec![p(None, Some(10)), p(Some(20), None)]).expired_by(1_000));
        assert!(alert(vec![p(None, Some(10)), p(Some(20), Some(30))]).expired_by(1_000));
    }
}
