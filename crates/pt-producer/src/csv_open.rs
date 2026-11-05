use crate::error::Result;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// Some real-world GTFS feeds (notably several European municipal exports)
// prefix CSV files with a UTF-8 BOM. The `csv` crate does not strip it, so
// header lookups like `"stop_id"` would fail because the first column reads
// as `"\u{feff}stop_id"`. The hand-rolled parser already strips BOM
// explicitly; this helper keeps the csv-based variants behaviourally aligned
// so all three measurement variants process identical bytes.
pub fn open_csv_skip_bom(path: &Path) -> Result<File> {
    let mut file = File::open(path)?;
    let mut bom = [0u8; 3];
    let n = file.read(&mut bom)?;
    if !(n == 3 && bom == [0xef, 0xbb, 0xbf]) {
        file.seek(SeekFrom::Start(0))?;
    }
    Ok(file)
}
