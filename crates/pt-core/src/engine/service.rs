use crate::engine::bitset::Bitset;
use crate::engine::EngineError;
use crate::reader::service_active_bit;
use crate::Reader;

/// Build the active-service membership set for `date` (YYYYMMDD) as a [`Bitset`]
/// indexed by `serviceIdx`. `active.get(s) == true` ⇔ service `s` runs on `date`.
///
/// The membership index is a packed [`Bitset`]
/// (one bit per service), replacing the previous `Vec<bool>` (one byte per
/// service). Pure representation change — the hot-path predicate decides
/// identically.
///
/// Decode-distinct-pool-once: the `0x15 ServiceBitfieldPool` de-dups distinct
/// day-vectors and `0x16 ServiceToBitfield` maps each service to one. Evaluate
/// active-on-`date` ONCE per DISTINCT bitfield (`service_bitfield_pool_count()`
/// of them — typically far fewer than `num_services`), then fan the result out
/// to each service via its pool index. This is the "strictly cheaper" path
/// the pool exists for.
///
/// The per-bitfield check is the one `service_active_on` uses: compute the
/// in-window `day` offset via `Reader::day_offset` ONCE, then
/// `service_active_bit(bitfield, day)`. An out-of-window `date` ⇒ every bit
/// clear (`day_offset` is `None`).
pub fn active_services<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    date: u32,
) -> Result<Bitset, EngineError> {
    let n = reader.num_services(); // -> u32, infallible
    let mut active = Bitset::with_len(n as usize);

    let count = reader.service_bitfield_pool_count();
    // The single shared window guard; `None` ⇒ out of window ⇒ all inactive,
    // so every `pool_active` entry is false and `active` stays all-clear.
    let day = reader.day_offset(date);
    // `poolActive[p]` for each distinct bitfield `p` in `0..count`.
    let mut pool_active = alloc::vec![false; count as usize];
    if let Some(day) = day {
        for (p, slot) in pool_active.iter_mut().enumerate() {
            *slot = service_active_bit(reader.service_pool_bitfield(p as u32), day);
        }
    }
    for s in 0..n {
        // Load-time gates guarantee a pool index exists and is `< count` for
        // every service; `get` keeps the fan-out panic-free regardless.
        if let Some(pool_idx) = reader.service_pool_index(s) {
            if pool_active.get(pool_idx as usize) == Some(&true) {
                active.set(s as usize);
            }
        }
    }
    Ok(active)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testkit::{build_service_pool_ptb, ServicePoolSpec, SoaRoute, SoaStop};

    #[test]
    fn active_set_for_pinned_date() {
        let r = crate::engine::testkit::tiny_reader();
        // tiny.ptb fixture uses synthetic bitmasks (not real calendar.txt bits):
        //   service 0 (SA): byte j = 0xA0 + j
        //   service 1 (WD): byte j = 0xB0 + j
        //   feedStartDate = 20260501
        //
        // Date 20260505 -> day offset 4 (May 1 = 0, ..., May 5 = 4).
        // Byte 0 covers days 0-7.  Bit = offset % 8 = 4.
        //   SA byte0 = 0xA0 = 0b10100000 -> bit4 = 0  -> inactive
        //   WD byte0 = 0xB0 = 0b10110000 -> bit4 = 1  -> active
        let set = active_services(&r, 20260505).unwrap();
        assert_eq!(set.len(), 2);
        assert!(!set.get(0), "SA (service 0) must be inactive on 20260505");
        assert!(set.get(1), "WD (service 1) must be active on 20260505");
    }

    fn stop(id: &str) -> SoaStop<'_> {
        SoaStop {
            id,
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        }
    }

    fn route(id: &str) -> SoaRoute<'_> {
        SoaRoute {
            id,
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        }
    }

    /// The Bitset membership produced by `active_services` must EQUAL the
    /// pre-change `Vec<bool>` reference (one `reader.service_active_on(s, date)`
    /// per service) on the decode-once path, for every in-window day AND an
    /// out-of-window day. This proves the decode-once fan-out is bit-identical to
    /// the naive per-service evaluation it replaces.
    #[test]
    fn decode_once_membership_equals_per_service_reference() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        // Two distinct bitfields, mapped across 4 services (1 -> bf_a, 3 -> bf_b).
        let bf_a = {
            let mut v = alloc::vec![0u8; s];
            v[0] = 0b0001_0101; // days 0, 2, 4 active
            v[1] = 0b1000_0001; // days 8, 15 active
            v
        };
        let bf_b = {
            let mut v = alloc::vec![0u8; s];
            v[0] = 0b0000_0010; // day 1 active
            v[3] = 0b0000_1000; // day 27 active
            v
        };
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf_a.as_slice(), bf_b.as_slice()];
        let s2b: [u32; 4] = [1, 0, 1, 0]; // s0->bf_b, s1->bf_a, s2->bf_b, s3->bf_a
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &s2b,
        };
        let stops = [stop("s0"), stop("s1")];
        let routes = [route("R0")];
        let bytes = build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec);
        let r = crate::Reader::from_bytes(bytes).expect("decode service-pool bundle");
        assert_eq!(r.num_services(), 4);
        // Sanity: it really is the decode-once path (a distinct pool decoded).
        assert_eq!(r.service_bitfield_pool_count(), 2);

        let anchor = r.feed_start_date();
        // Every in-window day + one out-of-window day.
        let mut dates: alloc::vec::Vec<u32> = (0..r.window_days() as i64)
            .map(|d| crate::reader::days_add(anchor, d))
            .collect();
        dates.push(crate::reader::days_add(anchor, r.window_days() as i64 + 5)); // out of window

        for date in dates {
            let set = active_services(&r, date).unwrap();
            for svc in 0..r.num_services() {
                let want = r.service_active_on(svc, date); // the per-service reference
                assert_eq!(
                    set.get(svc as usize),
                    want,
                    "decode-once service {svc} date {date} != per-service reference"
                );
            }
        }
    }

    /// M2 — `count == 1` two ways.
    ///
    /// (a) An all-ZERO feed: a single distinct all-zero bitfield ⇒ pool count is
    /// `1` (the de-dup folds every service onto one zero vector, NOT count 0), and
    /// EVERY service is inactive on every probed day — day 0, the last in-window
    /// day, and an out-of-window day (proves the bitset starts and stays clear).
    #[test]
    fn m2_all_zero_feed_count_one_all_inactive() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let zero = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![zero.as_slice()];
        let s2b: [u32; 3] = [0, 0, 0]; // all three services -> the single zero bitfield
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &s2b,
        };
        let stops = [stop("s0"), stop("s1")];
        let routes = [route("R0")];
        let bytes = build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec);
        let r = crate::Reader::from_bytes(bytes).expect("decode all-zero pool bundle");
        assert_eq!(r.service_bitfield_pool_count(), 1, "single zero bitfield");
        assert_eq!(r.num_services(), 3);

        let anchor = r.feed_start_date();
        let window = r.window_days() as i64;
        for date in [
            anchor,                                       // d = 0
            crate::reader::days_add(anchor, window - 1),  // last in-window day
            crate::reader::days_add(anchor, window + 10), // out of window
        ] {
            let set = active_services(&r, date).unwrap();
            for svc in 0..r.num_services() {
                assert!(
                    !set.get(svc as usize),
                    "all-zero feed: service {svc} must be inactive on date {date}"
                );
            }
        }
    }

    /// (b) An all-IDENTICAL non-zero feed: a single distinct non-zero bitfield ⇒
    /// pool count `1`, and EVERY service is active on the in-window day that
    /// bitfield marks (proves the bitset FILL fans the single pool entry out to
    /// every mapped service).
    #[test]
    fn m2_all_identical_nonzero_feed_count_one_all_active() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        // One distinct bitfield, day 0 active.
        let bf = {
            let mut v = alloc::vec![0u8; s];
            v[0] = 0b0000_0001; // day 0 active
            v
        };
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice()];
        let s2b: [u32; 4] = [0, 0, 0, 0];
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &s2b,
        };
        let stops = [stop("s0"), stop("s1")];
        let routes = [route("R0")];
        let bytes = build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec);
        let r = crate::Reader::from_bytes(bytes).expect("decode all-identical pool bundle");
        assert_eq!(r.service_bitfield_pool_count(), 1);
        assert_eq!(r.num_services(), 4);

        let anchor = r.feed_start_date(); // day 0 -> the active day
        let set = active_services(&r, anchor).unwrap();
        for svc in 0..r.num_services() {
            assert!(
                set.get(svc as usize),
                "all-identical non-zero feed: service {svc} must be active on day 0"
            );
        }
        // And inactive on a different in-window day the bitfield does NOT mark.
        let other = crate::reader::days_add(anchor, 1);
        let set_other = active_services(&r, other).unwrap();
        for svc in 0..r.num_services() {
            assert!(
                !set_other.get(svc as usize),
                "service {svc} must be inactive on day 1 (bitfield marks only day 0)"
            );
        }
    }
}
