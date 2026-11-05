//! H69: a catalogue built with stored trip spans (templates built at a
//! trip's first instance) equals one built the original way: same events,
//! arrival index, diagnostics, binding and errors.
use super::*;
use core::ops::Range;
use std::eprintln;

fn assert_same<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    cfg: &TransferIndexConfig,
) -> bool {
    let plain = build_event_index(reader, index, None, cfg);
    let spanned = build_event_index_with_spans_for_test(reader, index, cfg);
    match (plain, spanned) {
        (Ok(a), Ok(b)) => {
            assert_eq!(a.events(), b.events());
            assert_eq!(a.diagnostics(), b.diagnostics());
            assert_eq!(a.binding(), b.binding());
            assert_eq!(a.covered(), b.covered());
            for stop in 0..reader.num_stops() as u32 {
                assert_eq!(a.arrivals_at_stop(stop), b.arrivals_at_stop(stop));
            }
            true
        }
        (Err(a), Err(b)) => {
            assert_eq!(a, b);
            false
        }
        (a, b) => panic!(
            "trip spans change the outcome: plain ok={} spanned ok={}",
            a.is_ok(),
            b.is_ok()
        ),
    }
}

const WINDOWS: [Range<i64>; 5] = [
    0..86_400,
    21_600..36_001,
    43_200..57_600,
    64_800..79_200,
    1_000..1_001,
];

fn sweep<B: AsRef<[u8]> + Send + Sync + 'static>(reader: &Reader<B>, dates: &[u32]) -> usize {
    let mut built = 0;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        // A derived-block bundle commits to its producer's pattern mode; other
        // modes fail `Index::build` with `IndexBundleMismatch` and are skipped.
        let index = match Index::build(reader, mode) {
            Ok(index) => index,
            Err(EngineError::IndexBundleMismatch) => continue,
            Err(e) => panic!("index: {e:?}"),
        };
        for &date in dates {
            for window in WINDOWS {
                for mobility in [Mobility::Default, Mobility::Wheelchair] {
                    let cfg = TransferIndexConfig {
                        mobility,
                        ..TransferIndexConfig::new(date, window.clone())
                    };
                    built += usize::from(assert_same(reader, &index, &cfg));
                }
            }
        }
    }
    built
}

fn feed_dates<B: AsRef<[u8]> + Send + Sync + 'static>(reader: &Reader<B>) -> Vec<u32> {
    let days = reader.num_service_day_origins().saturating_sub(1);
    (0..days)
        .map(|d| crate::reader::days_add(reader.feed_start_date(), d as i64))
        .collect()
}

#[test]
fn trip_spans_keep_test_network_catalogues() {
    for net in [lattice(3, 1, false), lattice(4, 2, true)] {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let dates = feed_dates(&reader);
        assert!(sweep(&reader, &dates) > 0, "some catalogue must build");
    }
}

#[test]
fn trip_spans_keep_committed_fixture_catalogues() {
    // tiny-v2 is the committed v2 fixture; the event catalogue needs PTB v2.
    let bytes =
        include_bytes!("../../../../../../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb");
    let reader = Reader::from_bytes(bytes.to_vec()).unwrap();
    let dates = feed_dates(&reader);
    assert!(sweep(&reader, &dates) > 0, "some catalogue must build");
}

/// The H69 gate on a real bundle: `PTN_H69_BUNDLE=<path> cargo test --release
/// ... trip_spans_keep_bundle_catalogues -- --ignored`.
#[test]
#[ignore]
fn trip_spans_keep_bundle_catalogues() {
    let path = std::env::var("PTN_H69_BUNDLE").expect("PTN_H69_BUNDLE");
    let reader = Reader::from_bytes(std::fs::read(path).unwrap()).unwrap();
    let dates = feed_dates(&reader);
    let built = sweep(&reader, &dates);
    eprintln!("dates={} catalogues_built={built}", dates.len());
    assert!(built > 0);
}
