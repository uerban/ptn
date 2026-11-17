use pt_core::Reader;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stop<'a> {
    stop_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    lat_e7: i32,
    lon_e7: i32,
}

/// Export the compiled stop population without building an index, planning a
/// query, or expanding the timetable. Coordinates remain exact E7 integers.
pub fn run(args: &[String]) -> Result<String, String> {
    export(args, false)
}

pub fn review_context(args: &[String]) -> Result<String, String> {
    export(args, true)
}

fn export(args: &[String], names: bool) -> Result<String, String> {
    if args.len() != 1 {
        let command = if names {
            "review-stop-context"
        } else {
            "stop-universe"
        };
        return Err(format!("usage: {command} <ptb-path>"));
    }
    let bytes = std::fs::read(&args[0]).map_err(|e| format!("read PTB: {e}"))?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("ptb decode: {e:?}"))?;
    let mut stops = Vec::with_capacity(reader.num_stops());
    for index in 0..reader.num_stops() {
        let stop_id = reader
            .stop_id(index)
            .map_err(|e| format!("stop id: {e:?}"))?;
        let lat_e7 = reader
            .stop_lat_e7(index)
            .map_err(|e| format!("stop latitude: {e:?}"))?;
        let lon_e7 = reader
            .stop_lon_e7(index)
            .map_err(|e| format!("stop longitude: {e:?}"))?;
        if stop_id.is_empty()
            || !(-900_000_000..=900_000_000).contains(&lat_e7)
            || !(-1_800_000_000..=1_800_000_000).contains(&lon_e7)
        {
            return Err(format!("invalid sampling stop at index {index}"));
        }
        stops.push(Stop {
            stop_id,
            name: if names {
                Some(
                    reader
                        .stop_name(index)
                        .map_err(|e| format!("stop name: {e:?}"))?,
                )
            } else {
                None
            },
            lat_e7,
            lon_e7,
        });
    }
    stops.sort_unstable_by(|a, b| a.stop_id.as_bytes().cmp(b.stop_id.as_bytes()));
    if stops
        .windows(2)
        .any(|pair| pair[0].stop_id == pair[1].stop_id)
    {
        return Err("duplicate compiled stop id".into());
    }
    let value = serde_json::json!({
        "format": if names { "ptn-search-review-stop-context" } else { "ptn-search-stop-universe" }, "version": 1,
        "ptbSha256": digest, "ordering": "utf8-stop-id",
        "derivation": if names { "pt-core-reader-e7-name-v1" } else { "pt-core-reader-e7-v1" }, "stops": stops,
    });
    serde_json::to_string(&value).map_err(|e| e.to_string())
}
