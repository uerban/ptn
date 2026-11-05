use pt_producer::layout::{Layout, Region};
use pt_producer::writer::{open_writer, WriteRegion};

#[test]
fn writer_round_trip_through_stop_times_region() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin");
    let layout = Layout::compute(3, 2, 4, 12, 90, 2, 0, 0);
    const STRIDE: usize = 12;

    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
    {
        let slice = w.region_slice(&layout, Region::StopTimes);
        assert_eq!(slice.len(), 12 * STRIDE);
        for (i, row) in slice.chunks_exact_mut(STRIDE).enumerate() {
            row[0..4].copy_from_slice(&(i as u32).to_le_bytes());
            // remaining 8 bytes left zero (fills them)
        }
    }
    w.finish().unwrap();

    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(bytes.len() as u64, layout.total_bytes());
    let off = layout.offset(Region::StopTimes) as usize;
    for i in 0..12 {
        let row_off = off + i * STRIDE;
        let v = u32::from_le_bytes(bytes[row_off..row_off + 4].try_into().unwrap());
        assert_eq!(v, i as u32);
    }
}

#[test]
fn writer_creates_file_at_expected_total_size() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin");
    let layout = Layout::compute(10, 5, 20, 100, 90, 4, 0, 0);
    let w = open_writer(&out, layout.total_bytes()).unwrap();
    w.finish().unwrap();
    let meta = std::fs::metadata(&out).unwrap();
    assert_eq!(meta.len(), layout.total_bytes());
}
