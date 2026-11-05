use crate::csv_open::open_csv_skip_bom;
use crate::error::{Error, Result};
use crate::sidecars::{ShapeGroup, ShapePoint};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// Parse shapes.txt from each feed directory, group by shape_id, sort points by
/// shape_pt_sequence. Returns empty Vec if no shapes.txt exists in any feed dir.
/// Output is sorted by shape_id so the JSON sidecar bytes are deterministic
/// regardless of HashMap iteration order.
///
/// Each emitted group carries `trip_ref_count` — the number of trips in
/// trips.txt referencing the shape — so the PTB loader can reproduce the Node
/// `buildShapesIndex` orphan-filter + cap-eviction + ordering exactly.
pub fn parse_shapes_all(feed_dirs: &[std::path::PathBuf]) -> Result<Vec<ShapeGroup>> {
    let mut grouped: BTreeMap<String, Vec<(u32, ShapePoint)>> = BTreeMap::new();
    for dir in feed_dirs {
        parse_one(&dir.join("shapes.txt"), &mut grouped)?;
    }
    let mut refs: HashMap<String, u32> = HashMap::new();
    let mut seen_trips: HashSet<String> = HashSet::new();
    for dir in feed_dirs {
        count_trip_shape_refs(&dir.join("trips.txt"), &mut refs, &mut seen_trips)?;
    }
    let mut out = Vec::with_capacity(grouped.len());
    for (shape_id, mut points) in grouped {
        points.sort_by_key(|(seq, _)| *seq);
        let trip_ref_count = refs.get(&shape_id).copied().unwrap_or(0);
        out.push(ShapeGroup {
            shape_id,
            points: points.into_iter().map(|(_, p)| p).collect(),
            trip_ref_count,
        });
    }
    Ok(out)
}

/// Tally how many trips reference each `shape_id`. `shape_id` is an optional
/// column in trips.txt (and individual rows may leave it blank); a missing
/// column or empty value contributes nothing, so such shapes report 0 refs and
/// the loader treats them as orphans — matching the Node path, which only
/// counts trips that actually carry a shape_id.
///
/// Trips are deduplicated by `trip_id` with first-occurrence-wins, mirroring
/// the Node `mergeSmallFiles` merge (`packages/backend/src/gtfs/loader.ts`):
/// when the same `trip_id` appears more than once (duplicate rows within a
/// feed or the same id across feeds in a multi-feed city), only the first
/// row's `shape_id` is counted. Without this, a duplicate `T1 -> SH_B` after a
/// `T1 -> SH_A` would keep `SH_B` alive here even though Node drops it, so the
/// PTB orphan-filter / cap-eviction order would diverge from the Node path.
/// `seen_trips` is threaded across all feed dirs so the dedup is global, just
/// like the single merged trips map on the Node side.
///
/// A feed whose trips.txt omits the optional `shape_id` column entirely still
/// claims its `trip_id`s into `seen_trips` (only the ref increment is skipped).
/// Node parses those rows as `shapeId: undefined` trips and merges them by
/// `trip_id` regardless, so a shapeless earlier feed must still suppress a
/// later feed's duplicate `trip_id -> shape_id` — otherwise the later shape
/// would stay live here while Node orphans it.
fn count_trip_shape_refs(
    path: &Path,
    refs: &mut HashMap<String, u32>,
    seen_trips: &mut HashSet<String>,
) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let file = open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();
    // shape_id is optional; when the column is absent the loop below still runs
    // to claim trip_ids (the dedup must stay global), only skipping ref counts.
    let idx_shape = headers.iter().position(|h| h == "shape_id");
    // trip_id is a required GTFS column (Pass 1 errors if it is missing, and
    // runs before sidecars are written); when present it drives the dedup.
    let idx_trip = headers.iter().position(|h| h == "trip_id");
    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        // Claim the trip_id slot first-wins, BEFORE inspecting shape_id, so a
        // shapeless first row (or a feed with no shape_id column at all) still
        // suppresses a later duplicate's shape_id — exactly as Node's keep-first
        // merge would.
        if let Some(ti) = idx_trip {
            if let Some(trip_id) = record.get(ti) {
                if !seen_trips.insert(trip_id.trim().to_string()) {
                    continue;
                }
            }
        }
        if let Some(idx_shape) = idx_shape {
            if let Some(shape_id) = record.get(idx_shape) {
                let shape_id = shape_id.trim();
                if !shape_id.is_empty() {
                    *refs.entry(shape_id.to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    Ok(())
}

fn parse_one(path: &Path, grouped: &mut BTreeMap<String, Vec<(u32, ShapePoint)>>) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let file = open_csv_skip_bom(path)?;
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(file);
    let headers = rdr.headers()?.clone();
    let idx_id = header_idx(&headers, "shape_id")?;
    let idx_lat = header_idx(&headers, "shape_pt_lat")?;
    let idx_lon = header_idx(&headers, "shape_pt_lon")?;
    let idx_seq = header_idx(&headers, "shape_pt_sequence")?;
    let idx_dist = headers.iter().position(|h| h == "shape_dist_traveled");
    for rec in rdr.records() {
        let rec = rec?;
        let shape_id = rec
            .get(idx_id)
            .ok_or_else(|| Error::MalformedGtfs("shapes.txt: missing shape_id".into()))?
            .to_string();
        let lat: f32 = rec
            .get(idx_lat)
            .ok_or_else(|| Error::MalformedGtfs("shapes.txt: missing shape_pt_lat".into()))?
            .trim()
            .parse()
            .map_err(|e| Error::MalformedGtfs(format!("shapes.txt lat: {e}")))?;
        let lon: f32 = rec
            .get(idx_lon)
            .ok_or_else(|| Error::MalformedGtfs("shapes.txt: missing shape_pt_lon".into()))?
            .trim()
            .parse()
            .map_err(|e| Error::MalformedGtfs(format!("shapes.txt lon: {e}")))?;
        let seq: u32 = rec
            .get(idx_seq)
            .ok_or_else(|| Error::MalformedGtfs("shapes.txt: missing shape_pt_sequence".into()))?
            .trim()
            .parse()
            .map_err(|e| Error::MalformedGtfs(format!("shapes.txt seq: {e}")))?;
        let dist = match idx_dist.and_then(|i| rec.get(i)) {
            Some(s) => {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(
                        t.parse::<f32>()
                            .map_err(|e| Error::MalformedGtfs(format!("shapes.txt dist: {e}")))?,
                    )
                }
            }
            None => None,
        };
        grouped.entry(shape_id).or_default().push((
            seq,
            ShapePoint {
                lat,
                lon,
                shape_dist_traveled: dist,
            },
        ));
    }
    Ok(())
}

fn header_idx(headers: &csv::StringRecord, name: &str) -> Result<usize> {
    headers
        .iter()
        .position(|h| h == name)
        .ok_or_else(|| Error::MalformedGtfs(format!("shapes.txt missing column: {name}")))
}
