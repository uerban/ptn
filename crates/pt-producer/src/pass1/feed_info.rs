//! Parse GTFS `feed_info.txt` for feed provenance/attribution metadata.
//!
//! GTFS reference: https://gtfs.org/documentation/schedule/reference/#feed_infotxt
//! — optional file, at most one meaningful row ("exactly one record" per
//! spec). Extra rows beyond the first are ignored.

use std::path::Path;

use crate::error::Result;

/// Parsed `feed_info.txt` metadata for one feed directory. Optional GTFS
/// file → all-None when absent. The file carries at most one meaningful
/// row ("exactly one record" per spec); extra rows are ignored.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#feed_infotxt
#[derive(Clone, Debug, Default)]
pub struct FeedInfo {
    pub publisher_name: Option<String>,
    pub lang: Option<String>,
    pub feed_version: Option<String>,
}

pub fn parse_feed_info(feed_dir: &Path) -> Result<FeedInfo> {
    let path = feed_dir.join("feed_info.txt");
    if !path.exists() {
        return Ok(FeedInfo::default());
    }
    let file = crate::csv_open::open_csv_skip_bom(&path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();
    let col_name = headers.iter().position(|h| h == "feed_publisher_name");
    let col_lang = headers.iter().position(|h| h == "feed_lang");
    let col_version = headers.iter().position(|h| h == "feed_version");

    let mut record = csv::StringRecord::new();
    if rdr.read_record(&mut record)? {
        let get = |col: Option<usize>| {
            col.and_then(|i| record.get(i))
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        return Ok(FeedInfo {
            publisher_name: get(col_name),
            lang: get(col_lang),
            feed_version: get(col_version),
        });
    }
    Ok(FeedInfo::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_feed_info_row() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("feed_info.txt"),
            "feed_publisher_name,feed_publisher_url,feed_lang,feed_version\nExample Transit,https://example.com,lt,2026-06\n",
        )
        .unwrap();
        let info = parse_feed_info(dir.path()).unwrap();
        assert_eq!(info.publisher_name.as_deref(), Some("Example Transit"));
        assert_eq!(info.lang.as_deref(), Some("lt"));
        assert_eq!(info.feed_version.as_deref(), Some("2026-06"));
    }

    #[test]
    fn absent_file_gives_default() {
        let dir = tempfile::TempDir::new().unwrap();
        let info = parse_feed_info(dir.path()).unwrap();
        assert!(info.publisher_name.is_none());
        assert!(info.lang.is_none());
        assert!(info.feed_version.is_none());
    }
}
