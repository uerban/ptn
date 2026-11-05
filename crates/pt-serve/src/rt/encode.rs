//! Minimal protobuf ENCODER for the `RouteUpdate` message served by
//! `GET /api/<city>/rt/<routeId>`.
//!
//! Counterpart to the hand-rolled decoder in `rt/protobuf.rs`, and hand-rolled
//! for the same reason: the whole message is three scalar fields and a repeated
//! sub-message, so a `prost` + `protoc` build dependency would cost far more
//! than it saves (the decision recorded when the poller landed).
//!
//! WIRE SCHEMA — mirrors `packages/shared/src/proto/route-update.ts`, which
//! builds it at runtime with protobufjs rather than from a `.proto` file, so
//! that TypeScript IS the schema:
//!
//! ```text
//! message TripUpdate {
//!   string tripId       = 1;   // wire type 2
//!   sint32 delaySeconds = 2;   // wire type 0, ZIGZAG
//!   bool   cancelled    = 3;   // wire type 0
//!   bool   deleted      = 4;   // wire type 0 — ONLY when true (see 2.)
//! }
//! message RouteUpdate {
//!   string          routeId     = 1;  // wire type 2
//!   repeated TripUpdate trips   = 2;  // wire type 2
//!   int64           generatedAt = 3;  // wire type 0, NOT zigzag
//! }
//! ```
//!
//! TWO THINGS THAT ARE EASY TO GET WRONG AND ARE NOT SYMMETRIC:
//!
//! 1. `delaySeconds` is `sint32` (zigzag) but `generatedAt` is `int64` (plain
//!    varint). A negative delay is normal — a vehicle running early — so
//!    encoding it as a plain varint would emit ten bytes of sign extension that
//!    protobufjs then reads back as a huge positive number. There is no
//!    negative `generatedAt`, so that field must NOT be zigzagged or every
//!    timestamp doubles.
//!
//! 2. EVERY FIELD IS ALWAYS EMITTED, including zero values. protobuf3 encoders
//!    normally skip defaults, and skipping would still decode correctly in
//!    isolation — but protobufjs's `toObject` is called WITHOUT `defaults:true`
//!    (`decodeRouteUpdate`), so an omitted field comes back as `undefined`
//!    rather than `0`/`false`. `RtTripUpdate` declares both as required, and a
//!    client doing arithmetic on `undefined` delay gets `NaN`. Node emits them
//!    because `RouteUpdate.create()` makes every supplied key an own property;
//!    matching that is what keeps the two planes' bodies interchangeable.
//!    The one exception is `deleted` (field 4), added after Node: it is
//!    OPTIONAL in `RtTripUpdate`, absent reads as "not deleted", and emitting
//!    it only when true leaves every existing body byte-identical.

/// Append a protobuf tag (field number + wire type).
fn put_tag(out: &mut Vec<u8>, field: u32, wire_type: u32) {
    put_varint(out, u64::from((field << 3) | wire_type));
}

/// Append a base-128 varint, least-significant group first.
fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// ZigZag-encode a signed 32-bit value: `(n << 1) ^ (n >> 31)`.
///
/// `wrapping_shl` is not needed, but the cast chain is: `n >> 31` is an
/// ARITHMETIC shift on `i32` (all-ones for negatives, zero otherwise), and the
/// result must become `u32` before widening or the sign extends again.
fn zigzag32(n: i32) -> u64 {
    u64::from(((n << 1) ^ (n >> 31)) as u32)
}

fn put_string(out: &mut Vec<u8>, field: u32, value: &str) {
    put_tag(out, field, 2);
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
}

/// One trip of a `RouteUpdate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedTrip {
    pub trip_id: String,
    pub delay_seconds: i32,
    pub cancelled: bool,
    pub deleted: bool,
}

/// One `TripUpdate` sub-message, as the bytes that go inside its length prefix.
fn encode_trip_update(trip: &EncodedTrip) -> Vec<u8> {
    let mut out = Vec::new();
    put_string(&mut out, 1, &trip.trip_id);
    put_tag(&mut out, 2, 0);
    put_varint(&mut out, zigzag32(trip.delay_seconds));
    put_tag(&mut out, 3, 0);
    put_varint(&mut out, u64::from(trip.cancelled));
    if trip.deleted {
        put_tag(&mut out, 4, 0);
        put_varint(&mut out, 1);
    }
    out
}

/// Encode a whole `RouteUpdate`.
///
/// `generated_at` is milliseconds since the epoch, matching Node's
/// `Date.now()` — the field is `int64` on the wire and the client reads it back
/// through `toObject({longs: Number})`.
pub fn encode_route_update(route_id: &str, trips: &[EncodedTrip], generated_at_ms: i64) -> Vec<u8> {
    let mut out = Vec::new();
    put_string(&mut out, 1, route_id);
    for trip in trips {
        let body = encode_trip_update(trip);
        put_tag(&mut out, 2, 2);
        put_varint(&mut out, body.len() as u64);
        out.extend_from_slice(&body);
    }
    put_tag(&mut out, 3, 0);
    put_varint(&mut out, generated_at_ms as u64);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rt::protobuf::Reader;

    /// Decode a RouteUpdate with the crate's own reader. Round-tripping through
    /// the decoder that already parses real stops.lt bytes is a stronger check
    /// than comparing against a hand-written byte literal, because the decoder
    /// is independently verified against `gtfs-realtime-bindings` output.
    fn t(trip_id: &str, delay_seconds: i32, cancelled: bool) -> EncodedTrip {
        EncodedTrip {
            trip_id: trip_id.to_string(),
            delay_seconds,
            cancelled,
            deleted: false,
        }
    }

    fn decode_route_update(buf: &[u8]) -> (String, Vec<EncodedTrip>, i64) {
        let mut reader = Reader::new(buf);
        let (mut route_id, mut trips, mut generated_at) = (String::new(), Vec::new(), 0i64);
        while let Some((field, wire)) = reader.read_tag() {
            match (field, wire) {
                (1, 2) => {
                    route_id =
                        String::from_utf8(reader.read_length_delimited().unwrap().to_vec()).unwrap()
                }
                (2, 2) => {
                    let body = reader.read_length_delimited().unwrap();
                    let mut sub = Reader::new(body);
                    let (mut id, mut delay, mut cancelled, mut deleted) =
                        (String::new(), 0i32, false, false);
                    while let Some((f, w)) = sub.read_tag() {
                        match (f, w) {
                            (1, 2) => {
                                id =
                                    String::from_utf8(sub.read_length_delimited().unwrap().to_vec())
                                        .unwrap()
                            }
                            // Undo zigzag: (n >> 1) ^ -(n & 1)
                            (2, 0) => {
                                let raw = sub.read_varint().unwrap();
                                delay = ((raw >> 1) as i64 ^ -((raw & 1) as i64)) as i32;
                            }
                            (3, 0) => cancelled = sub.read_varint().unwrap() != 0,
                            (4, 0) => deleted = sub.read_varint().unwrap() != 0,
                            (_, w) => sub.skip_field(w).unwrap(),
                        }
                    }
                    trips.push(EncodedTrip {
                        trip_id: id,
                        delay_seconds: delay,
                        cancelled,
                        deleted,
                    });
                }
                (3, 0) => generated_at = reader.read_varint().unwrap() as i64,
                (_, w) => reader.skip_field(w).unwrap(),
            }
        }
        (route_id, trips, generated_at)
    }

    #[test]
    fn round_trips_a_realistic_update() {
        let trips = vec![t("trip-a", 456, false), t("trip-b", 0, true)];
        let buf = encode_route_update("route-7", &trips, 1_786_459_042_000);
        let (route_id, decoded, generated_at) = decode_route_update(&buf);
        assert_eq!(route_id, "route-7");
        assert_eq!(decoded, trips);
        assert_eq!(generated_at, 1_786_459_042_000);
    }

    #[test]
    fn a_negative_delay_survives_because_the_field_is_zigzagged() {
        // A vehicle running EARLY. Encoded as a plain varint this would be ten
        // bytes of sign extension that decodes as a huge positive delay — the
        // failure mode the sint32 mapping exists to prevent.
        let trips = vec![t("early", -180, false)];
        let buf = encode_route_update("r", &trips, 1);
        assert_eq!(decode_route_update(&buf).1, trips);
    }

    #[test]
    fn zigzag_matches_the_reference_mapping() {
        // The canonical table from the protobuf encoding docs.
        assert_eq!(zigzag32(0), 0);
        assert_eq!(zigzag32(-1), 1);
        assert_eq!(zigzag32(1), 2);
        assert_eq!(zigzag32(-2), 3);
        assert_eq!(zigzag32(2147483647), 4294967294);
        assert_eq!(zigzag32(-2147483648), 4294967295);
    }

    #[test]
    fn generated_at_is_a_plain_varint_not_a_zigzagged_one() {
        // The asymmetry with delaySeconds. If this field were zigzagged, every
        // timestamp would come back doubled — a silent 55-year offset that
        // still decodes as a valid number.
        let buf = encode_route_update("r", &[], 1_786_459_042_000);
        assert_eq!(decode_route_update(&buf).2, 1_786_459_042_000);
    }

    #[test]
    fn zero_valued_fields_are_still_emitted() {
        // proto3 encoders usually skip defaults. This one must not: the client
        // calls toObject WITHOUT `defaults:true`, so a skipped field decodes to
        // `undefined` rather than 0/false, and RtTripUpdate declares both as
        // required. Asserted on the byte length, since a round-trip through a
        // tolerant decoder cannot tell "absent" from "zero".
        let with_zeros = encode_route_update("r", &[t("t", 0, false)], 0);
        assert_eq!(
            with_zeros,
            vec![
                0x0a, 0x01, b'r', // routeId = "r"
                0x12, 0x07, // trips, sub-message of 7 bytes
                0x0a, 0x01, b't', //   tripId = "t"
                0x10, 0x00, //   delaySeconds = 0  <- must be present
                0x18, 0x00, //   cancelled = false <- must be present
                0x18, 0x00, // generatedAt = 0     <- must be present
            ],
            "every field must be on the wire even at its default value"
        );
    }

    #[test]
    fn a_deleted_trip_carries_field_4_and_no_other_trip_does() {
        let deleted = EncodedTrip {
            deleted: true,
            ..t("gone", 0, false)
        };
        let trips = vec![t("runs", 60, false), deleted.clone()];
        let buf = encode_route_update("r", &trips, 1);
        assert_eq!(decode_route_update(&buf).1, trips);
        // Field 4 appears once — on the deleted trip only (tag 0x20, value 1).
        assert_eq!(buf.windows(2).filter(|w| w == &[0x20, 0x01]).count(), 1);
    }

    #[test]
    fn an_empty_trip_list_still_carries_route_id_and_timestamp() {
        // The common case for a city with no RT feed, and for a route with no
        // live vehicles. Node returns the same shape rather than a 404.
        let buf = encode_route_update("route-7", &[], 42);
        let (route_id, trips, generated_at) = decode_route_update(&buf);
        assert_eq!(route_id, "route-7");
        assert!(trips.is_empty());
        assert_eq!(generated_at, 42);
    }

    #[test]
    fn multi_byte_lengths_and_utf8_ids_encode_correctly() {
        // A >127-byte string crosses the one-byte varint length boundary.
        let long_id = "ø".repeat(100); // 200 UTF-8 bytes
        let trips = vec![t(&long_id, 1, false)];
        let buf = encode_route_update(&long_id, &trips, 1);
        let (route_id, decoded, _) = decode_route_update(&buf);
        assert_eq!(route_id, long_id);
        assert_eq!(decoded, trips);
    }
}
