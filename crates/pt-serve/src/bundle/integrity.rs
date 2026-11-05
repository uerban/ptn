//! Cross-namespace integrity: recompute the bundle's Trips/Stops interner SHAs from the Reader so a
//! sidecar built against a DIFFERENT interning is rejected at load (concern X4). Shared by C2b
//! (`shapes.bin`) and C2c (`departures-idx.bin`).
//!
//! Soundness: the PTB Stop/Trip record at index `i` carries the sorted
//! post-finalize interner key `i` (producer `finalize()` sorts keys; records are
//! written in `keys()` order; the Reader decodes in record order). Iterating
//! `0..num_*` reproduces the exact key sequence the producer hashed.

use pt_core::Reader;
use pt_shared::validate::errors::{IoErr, ValidationError};

/// Recompute `(trips_intern_sha256, stops_intern_sha256)` from the reader's
/// record-order id sequence. A reader error (corrupt/misaligned record)
/// propagates as `ValidationError::Io(InvalidData)` — never silently substituted.
pub fn bundle_namespace_shas<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
) -> Result<([u8; 32], [u8; 32]), ValidationError> {
    let invalid = |what: &str| {
        ValidationError::Io(IoErr {
            kind: std::io::ErrorKind::InvalidData,
            msg: format!("interner recompute: {what}"),
        })
    };

    let mut stop_keys: Vec<&str> = Vec::with_capacity(reader.num_stops());
    for i in 0..reader.num_stops() {
        stop_keys.push(
            reader
                .stop_id(i)
                .map_err(|_| invalid("stop_id out of range"))?,
        );
    }
    let stops_sha = pt_shared::sidecar::intern_namespace_sha256(&stop_keys);

    let mut trip_keys: Vec<String> = Vec::with_capacity(reader.num_trips());
    for i in 0..reader.num_trips() {
        let t = reader.trip(i).map_err(|_| invalid("trip out of range"))?;
        trip_keys.push(t.trip_id);
    }
    let trips_sha = pt_shared::sidecar::intern_namespace_sha256(&trip_keys);

    Ok((trips_sha, stops_sha))
}
