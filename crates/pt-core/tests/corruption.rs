use pt_core::{PtbError, Reader};
mod util; // tests/util.rs

#[test]
fn rejects_short_buffer() {
    assert!(matches!(
        Reader::from_bytes(vec![0u8; 100]),
        Err(PtbError::BufferTooSmall { .. })
    ));
}
#[test]
fn rejects_v3_magic() {
    let mut b = util::assemble_empty();
    b[0..4].copy_from_slice(b"PTNB");
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::BadMagic { .. })
    ));
}
#[test]
fn rejects_v3_version() {
    let mut b = util::assemble_empty();
    b[4..6].copy_from_slice(&3u16.to_le_bytes());
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::UnsupportedVersion { got: 3 })
    ));
}
#[test]
fn rejects_region_out_of_bounds() {
    let mut b = util::assemble_empty();
    // point the first region (0x40 StopsSoA) past the buffer
    let past = b.len() as u64 + 4096;
    util::set_region_offset(&mut b, util::STOPS_SOA, past);
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::RegionOutOfBounds { .. })
    ));
}
#[test]
fn rejects_csr_value_out_of_range() {
    // srValues references a route index >= num_routes.
    let b = util::assemble_with_bad_csr();
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::CsrInvalid { .. })
    ));
}
#[test]
fn rejects_csr_offsets_last_exceeds_region() {
    // Distinct from the value-range case: srOffsets[last] points past srValues.
    // 1 stop, 0 routes; srOffsets=[0,5] but only 0 srValues laid out -> the
    // u32_range for srValues (len=5) overruns the region, or srOffsets[last] !=
    // srValues.len -> a clear Err (SliceOutOfBounds or CsrInvalid), never OOB.
    let mut csr = Vec::new();
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtOffsets[1]=[0]
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[0]=0
    csr.extend_from_slice(&5u32.to_le_bytes()); // srOffsets[1]=5 (claims 5 srValues)
                                                // no srValues bytes follow -> u32_range(len=5) overruns the CSR region.
    let b = util::assemble_bundle(&util::Bundle {
        num_stops: 1,
        stops_soa: util::stops_soa(&[1], &[2]),
        csr,
        string_pool: util::string_pool(&["", "S1", "Stop One"]),
        ..util::Bundle::empty()
    });
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::SliceOutOfBounds { .. }) | Err(PtbError::CsrInvalid { .. })
    ));
}
#[test]
fn rejects_stringpool_count_overflow() {
    // StringPool count claims more offsets than the region can hold.
    let mut b = util::assemble_empty();
    let sp_off = util::region_offset(&b, util::STRING_POOL);
    b[sp_off..sp_off + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::StringPoolMalformed { .. })
    ));
}
#[test]
fn rejects_stringpool_blob_length_mismatch() {
    // Declared blob terminator != actual region length -> length mismatch.
    let mut b = util::assemble_empty();
    let sp_off = util::region_offset(&b, util::STRING_POOL);
    // pool=[""] -> count=1, offsets[0..1] at sp_off+4; terminator at sp_off+8.
    b[sp_off + 8..sp_off + 12].copy_from_slice(&99u32.to_le_bytes()); // claim 99-byte blob
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::StringPoolMalformed { .. })
    ));
}
#[test]
fn rejects_stringpool_out_of_range_index() {
    // A stop whose stopId pool index is out of range -> StringIndexOutOfRange.
    let mut csr = Vec::new();
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtOffsets[1]
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[0]
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[1]
    let b = util::assemble_bundle(&util::Bundle {
        num_stops: 1,
        stops_soa: util::stops_soa(&[7], &[0]), // index 7, pool has 1 entry
        csr,
        ..util::Bundle::empty()
    });
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::StringIndexOutOfRange { .. })
    ));
}
#[test]
fn stop_times_not_a_whole_number_of_rows_rejected() {
    // SoA StopTimes must hold exactly 12 bytes per row: a 12*2 + 5 byte region
    // has no well-defined column split.
    let mut st = util::stop_times_soa(&[(0, 0, 0, 1), (100, 0, 1, 1)]);
    st.extend_from_slice(&[0xAA; 5]);
    let b = util::assemble_bundle(&util::Bundle {
        stop_times: st,
        trip_starts: util::u32s(&[2]),
        ..util::Bundle::empty()
    });
    assert!(matches!(
        Reader::from_bytes(b),
        Err(PtbError::CountExceedsRegion { .. })
    ));
}
#[test]
fn stop_time_columns_decode_per_field() {
    // Each SoA column decodes independently: depSecs=0x01020304, arrDiff=-3,
    // stopIdx=0xDEADBEEF, stopSeq=7.
    let b = util::assemble_bundle(&util::Bundle {
        stop_times: util::stop_times_soa(&[(0x0102_0304, -3, 0xDEAD_BEEF, 7)]),
        // (num_trips+1) = 1 entry whose last value is the total stop-time row
        // count = 1, satisfying the from_bytes `tripStarts[last] ==
        // num_stop_times` cross-check.
        trip_starts: util::u32s(&[1]),
        ..util::Bundle::empty()
    });
    let r = Reader::from_bytes(b).unwrap();
    let s = r.stop_time(0).unwrap();
    assert_eq!(s.dep_secs, 0x0102_0304);
    assert_eq!(s.arr_diff, -3);
    assert_eq!(s.stop_idx, 0xDEAD_BEEF);
    assert_eq!(s.stop_seq, 7);
}
#[test]
fn tolerates_trip_reserved_bytes_nonzero() {
    // Trip reserved [18..20] (the 2 bytes after direction_id@17) set to 0xFF.
    let mut t = vec![0u8; 24];
    t[0..4].copy_from_slice(&1u32.to_le_bytes()); // tripId -> "T1"
    t[4..8].copy_from_slice(&0u32.to_le_bytes()); // headsign -> ""
    t[8..12].copy_from_slice(&0u32.to_le_bytes()); // routeIdx
    t[12..16].copy_from_slice(&0u32.to_le_bytes()); // serviceIdx
    t[16] = 1; // wheelchair
    t[17] = 0; // direction_id
    t[18..20].copy_from_slice(&[0xFF, 0xFF]); // reserved [18..20] nonzero
    t[20..24].copy_from_slice(&0u32.to_le_bytes()); // shapeId -> ""
                                                    // 1 trip on 1 route; CSR: rtOff=[0,1], rtVal=[0]; srOff=[0], srVal=[].
    let mut csr = Vec::new();
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtOffsets[0]
    csr.extend_from_slice(&1u32.to_le_bytes()); // rtOffsets[1]=1
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtValues=[0]
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[1]=[0]
    let b = util::assemble_bundle(&util::Bundle {
        num_routes: 1,
        num_trips: 1,
        routes_soa: util::routes_soa(&[2]), // routeId -> "R1"
        trips: t,
        trip_starts: util::u32s(&[0, 0]),
        csr,
        string_pool: util::string_pool(&["", "T1", "R1"]),
        ..util::Bundle::empty()
    });
    let r = Reader::from_bytes(b).unwrap();
    assert_eq!(r.trip(0).unwrap().trip_id, "T1");
    assert_eq!(r.trip(0).unwrap().direction_id, 0);
}
#[test]
fn service_active_underflow_returns_false() {
    // date < feedStartDate -> false, never a panic.
    let b = util::assemble_empty(); // feedStartDate 20260501, 0 services
    let r = Reader::from_bytes(b).unwrap();
    assert!(!r.service_active_on(0, 20260401)); // before anchor
}
#[test]
fn empty_tables_ok() {
    let r = Reader::from_bytes(util::assemble_empty()).unwrap();
    assert_eq!(r.num_stops(), 0);
    assert_eq!(r.trip_starts().unwrap(), &[0u32]); // (num_trips+1) with num_trips=0
}

// ---- No-panic regression guards -------------------------------------------

#[test]
fn truncation_never_panics() {
    // Truncate the committed tiny.ptb at EVERY length; from_bytes must return
    // Err (never panic) for every prefix shorter than the whole bundle. The
    // test harness already fails on a panic in any thread, so a panic in
    // from_bytes fails this test.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/ptb/__fixtures__/tiny.ptb"
    );
    let full = std::fs::read(path).expect("read tiny.ptb");
    // The last region is page-aligned, so the file ends with padding bytes
    // beyond the last region's real content. A prefix that drops only padding
    // is still a complete, valid bundle — so the strict "every prefix <
    // full.len() must Err" invariant is wrong for padded bundles. Compute the
    // highest byte any tagged-table entry references; prefixes shorter than that
    // are genuinely truncated and MUST Err. Prefixes in [content_end,
    // full.len()) drop padding only and MAY decode Ok. The load-bearing
    // contract (the test name) is "never panic" — the harness fails on a panic
    // in from_bytes regardless of Ok/Err.
    Reader::from_bytes(full.clone()).expect("full bundle should decode");
    let mut content_end = 0usize;
    let mut e = 32;
    while u16::from_le_bytes(full[e..e + 2].try_into().unwrap()) != 0 {
        let off = u64::from_le_bytes(full[e + 8..e + 16].try_into().unwrap()) as usize;
        let len = u64::from_le_bytes(full[e + 16..e + 24].try_into().unwrap()) as usize;
        content_end = content_end.max(off + len);
        e += 24;
    }
    for len in 0..content_end {
        let prefix = full[..len].to_vec();
        assert!(
            Reader::from_bytes(prefix).is_err(),
            "truncated-to-{len} bundle (< content_end {content_end}) must Err, not panic or Ok"
        );
    }
    // Padding-only truncation: must not panic (Ok or Err both acceptable).
    for len in content_end..full.len() {
        let prefix = full[..len].to_vec();
        let _ = Reader::from_bytes(prefix); // no panic is the contract
    }
}

#[test]
fn header_region_table_byte_flips_never_panic() {
    // Flip each bit-byte to 0xFF (and 0x01) across the header + the first
    // bytes of the region table [0..160]; from_bytes must not panic. Ok or Err are both acceptable
    // outcomes — the contract is "no panic on hostile input".
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/ptb/__fixtures__/tiny.ptb"
    );
    let full = std::fs::read(path).expect("read tiny.ptb");
    for i in 0..160usize {
        for &v in &[0xFFu8, 0x01u8] {
            let mut b = full.clone();
            b[i] = v;
            // Either Ok or Err — just must not panic. (Harness catches panics.)
            let _ = Reader::from_bytes(b);
        }
    }
}

// ---- Variant-specific validate_csr / overflow tests -----------------------

#[test]
fn num_services_max_exceeds_region() {
    // num_services = u32::MAX with an empty 0x16 ServiceToBitfield index -> the
    // index length check rejects it.
    let mut b = util::assemble_empty();
    b[24..28].copy_from_slice(&u32::MAX.to_le_bytes()); // numServices @24
    match Reader::from_bytes(b).err() {
        Some(PtbError::ServiceBitfieldPoolInvalid { .. }) => {}
        other => panic!("expected ServiceBitfieldPoolInvalid, got {other:?}"),
    }
}

#[test]
fn rt_offsets_non_monotonic() {
    // 0 stops, 2 routes, 2 trips. rtOffsets = [0, 2, 1] (decreasing) -> CsrInvalid.
    let mut trips = vec![0u8; 24 * 2]; // both trips empty strings
    let mut csr = Vec::new();
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtOffsets[0]=0
    csr.extend_from_slice(&2u32.to_le_bytes()); // rtOffsets[1]=2
    csr.extend_from_slice(&1u32.to_le_bytes()); // rtOffsets[2]=1 (decreasing!)
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtValues[0]
    csr.extend_from_slice(&1u32.to_le_bytes()); // rtValues[1]
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[0]=0 (0 stops -> [0])
                                                // headsign idx for trips left 0 -> ""; routeIdx 0 left default.
    trips[8..12].copy_from_slice(&0u32.to_le_bytes());
    trips[32..36].copy_from_slice(&0u32.to_le_bytes());
    let b = util::assemble_bundle(&util::Bundle {
        num_routes: 2,
        num_trips: 2,
        routes_soa: util::routes_soa(&[1, 2]), // "R1", "R2"
        trips,
        trip_starts: util::u32s(&[0, 0, 0]),
        csr,
        string_pool: util::string_pool(&["", "R1", "R2"]),
        ..util::Bundle::empty()
    });
    match Reader::from_bytes(b).err() {
        Some(PtbError::CsrInvalid { detail }) => assert_eq!(detail, "rtOffsets not monotonic"),
        other => panic!("expected CsrInvalid{{rtOffsets not monotonic}}, got {other:?}"),
    }
}

#[test]
fn rt_offsets_last_ne_num_trips() {
    // 0 stops, 1 route, 1 trip, but rtOffsets[last]=0 != num_trips(1) -> the
    // specific "rtOffsets[last] != trips.len" detail.
    let trips = vec![0u8; 24]; // 1 trip, empty strings
    let mut csr = Vec::new();
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtOffsets[0]=0
    csr.extend_from_slice(&0u32.to_le_bytes()); // rtOffsets[1]=0 (should be 1)
                                                // rtValues len = last = 0 -> none.
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[0]=0
    let b = util::assemble_bundle(&util::Bundle {
        num_routes: 1,
        num_trips: 1,
        routes_soa: util::routes_soa(&[1]), // routeId -> "R1"
        trips,
        trip_starts: util::u32s(&[0, 0]),
        csr,
        string_pool: util::string_pool(&["", "R1"]),
        ..util::Bundle::empty()
    });
    match Reader::from_bytes(b).err() {
        Some(PtbError::CsrInvalid { detail }) => assert_eq!(detail, "rtOffsets[last] != trips.len"),
        other => panic!("expected CsrInvalid{{rtOffsets[last] != trips.len}}, got {other:?}"),
    }
}

#[test]
fn csr_region_offset_misaligned_by_one_byte() {
    // Shift the CSR region offset by +1 (odd) so the u32 cast is misaligned ->
    // bytemuck::try_cast_slice rejects it -> PtbError::Misaligned. Start from the
    // empty bundle (CSR present at a page-aligned offset) and nudge it by 1; the
    // CSR region is followed by page-aligned slack, so offset+length stays in
    // bounds and decode reaches the cast.
    let mut b = util::assemble_empty();
    let csr_off = util::region_offset(&b, util::CSR);
    util::set_region_offset(&mut b, util::CSR, csr_off as u64 + 1);
    match Reader::from_bytes(b).err() {
        Some(PtbError::Misaligned { .. }) => {}
        other => panic!("expected Misaligned, got {other:?}"),
    }
}
