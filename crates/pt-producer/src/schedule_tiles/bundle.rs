//! Bundle builder — port of buildBundle.ts. Writes
//! <dataDir>/<bundleHash>.tmp/6km/<coords>.br, then two-phase swap
//! (rename final→.old, tmp→final, rm .old). Same-tmpdir cleanup on error.
//! Manifest is written by the caller (orchestrate.rs), mirroring the
//! buildAndPublishBundle split.

use indexmap::IndexMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::brotli_tile::TileCompressor;
use super::grid::{Bbox, SCHEDULE_TILE_SIZE_LABEL};
use super::inputs::TileInputs;
use super::subdivide::{subdivide_cell, Precompressed, SubdivideArgs};
use super::tile::{build_tile_for_cell, group_stops_by_cell};
use super::wire::encode_schedule_tile;
use crate::error::{Error, Result};

pub struct LeafPlan {
    pub suffix: String,
    pub bbox: Bbox,
    pub compressed_bytes: usize,
    pub oversized: bool,
}

pub struct BuildStats {
    pub subdivided_cells: u32,
    pub max_depth: u32,
    pub oversized_leaves: u32,
    pub max_leaf_bytes: usize,
    pub cell_count: usize,
}

pub struct BuildBundleResult {
    pub tiles_written: u32,
    /// keyed by "<x>_<y>", present only for genuinely subdivided cells.
    pub subdivisions: IndexMap<String, Vec<LeafPlan>>,
    pub stats: BuildStats,
    /// stopId → on-disk tile coords (sans .br) — the stop-cell.json source.
    pub stop_tile_coords: IndexMap<String, String>,
}

/// Build the tile bundle for every cell of `inputs`.
///
/// `threads` is the number of worker threads building cells concurrently.
/// `1` is the sequential path: one cell in flight, the lowest peak memory.
/// More threads trade memory for wall-clock time: each worker holds one
/// cell's uncompressed JSON plus the q=11 encoder state at once (Paris's
/// largest cell is ~23 MB of JSON). The output is byte-identical whatever
/// the thread count: cells are independent, and the results are merged back
/// in cell order, so `subdivisions`, `stop_tile_coords` and the stats come
/// out exactly as the sequential loop builds them.
#[allow(clippy::too_many_arguments)]
pub fn build_bundle(
    inputs: &TileInputs,
    bundle_hash: &str,
    city_id: &str,
    data_dir: &Path,
    cap: usize,       // production: MAX_COMPRESSED_TILE_BYTES
    max_depth: usize, // production: MAX_SUBDIVISION_DEPTH
    compressor: &(dyn TileCompressor + Sync),
    threads: usize,
) -> Result<BuildBundleResult> {
    let final_dir = data_dir.join(bundle_hash);
    let tmp_dir = data_dir.join(format!("{bundle_hash}.tmp"));
    let tile_sub_dir = tmp_dir.join(SCHEDULE_TILE_SIZE_LABEL);
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let run = || -> Result<BuildBundleResult> {
        std::fs::create_dir_all(&tile_sub_dir)?;
        let cells: Vec<(String, Vec<usize>)> = group_stops_by_cell(inputs).into_iter().collect();
        let build = |cell_key: &str, cell_stops: &[usize]| {
            build_one_cell(
                inputs,
                bundle_hash,
                city_id,
                cap,
                max_depth,
                compressor,
                &tile_sub_dir,
                cell_key,
                cell_stops,
            )
            .map_err(|e| {
                // Per-cell error enrichment (buildBundle.ts:207-218) — wrap so
                // operators see which cell failed without extra
                // instrumentation. Prefix and key spellings ("buildBundle:",
                // "bundleHash=", "cityId=") deliberately match the Node
                // message verbatim so one grep covers both engines' logs.
                Error::Config(format!(
                    "buildBundle: failed building tile for cell \"{cell_key}\" \
                     (bundleHash={bundle_hash}, cityId={city_id}): {e}"
                ))
            })
        };
        // A cell's cost is roughly its departure rows; heaviest first.
        let weights: Vec<usize> = cells
            .iter()
            .map(|(_, stops)| stops.iter().map(|&si| inputs.stop_times[si].0.len()).sum())
            .collect();
        let outcomes = build_cells(&cells, &weights, threads.max(1), build)?;

        let mut tiles_written = 0u32;
        let mut subdivisions: IndexMap<String, Vec<LeafPlan>> = IndexMap::new();
        let mut stop_tile_coords: IndexMap<String, String> = IndexMap::new();
        let mut stats = BuildStats {
            subdivided_cells: 0,
            max_depth: 0,
            oversized_leaves: 0,
            max_leaf_bytes: 0,
            cell_count: cells.len(),
        };
        for ((cell_key, _), outcome) in cells.iter().zip(outcomes) {
            tiles_written += outcome.tiles_written;
            for (stop_id, coords) in outcome.stop_coords {
                stop_tile_coords.insert(stop_id, coords);
            }
            if let Some(plans) = outcome.plans {
                stats.subdivided_cells += 1;
                subdivisions.insert(cell_key.clone(), plans);
            }
            stats.max_depth = stats.max_depth.max(outcome.max_depth);
            stats.oversized_leaves += outcome.oversized_leaves;
            stats.max_leaf_bytes = stats.max_leaf_bytes.max(outcome.max_leaf_bytes);
        }

        // Bijection guard: every planned leaf exists on disk before the swap.
        for (cell_key, plans) in &subdivisions {
            for p in plans {
                let path = tile_sub_dir.join(format!("{cell_key}-{}.br", p.suffix));
                if !path.exists() {
                    // Message mirrors buildBundle.ts:226-229 verbatim
                    // (incl. "buildBundle:"/"bundleHash="/"cityId=" spellings)
                    // so one grep covers both engines' logs.
                    return Err(Error::Config(format!(
                        "buildBundle: subdivision plan/disk mismatch — planned leaf {cell_key}-{}.br \
                         was not written (bundleHash={bundle_hash}, cityId={city_id})",
                        p.suffix
                    )));
                }
            }
        }

        // Two-phase swap (buildBundle.ts:234-249).
        let old_dir = data_dir.join(format!("{bundle_hash}.old"));
        let _ = std::fs::remove_dir_all(&old_dir);
        match std::fs::rename(&final_dir, &old_dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        std::fs::rename(&tmp_dir, &final_dir)?;
        let _ = std::fs::remove_dir_all(&old_dir);

        Ok(BuildBundleResult {
            tiles_written,
            subdivisions,
            stats,
            stop_tile_coords,
        })
    };

    run().inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    })
}

/// What one cell contributed: its files are already on disk; this carries
/// the bookkeeping `build_bundle` folds in cell order.
struct CellOutcome {
    tiles_written: u32,
    /// (stop id, on-disk tile coords), in the order the sequential build
    /// inserted them.
    stop_coords: Vec<(String, String)>,
    /// `Some` only for a genuinely subdivided cell.
    plans: Option<Vec<LeafPlan>>,
    max_depth: u32,
    oversized_leaves: u32,
    max_leaf_bytes: usize,
}

/// Run `build` over every cell on `threads` workers and return the outcomes
/// in cell order. Workers claim cells heaviest `weights` first from a shared
/// counter: a dense city's few huge cells then run alongside the many small
/// ones instead of trailing alone at the end. On a failure the workers stop
/// claiming new cells and the failure of the lowest-numbered failed cell is
/// returned.
fn build_cells<F>(
    cells: &[(String, Vec<usize>)],
    weights: &[usize],
    threads: usize,
    build: F,
) -> Result<Vec<CellOutcome>>
where
    F: Fn(&str, &[usize]) -> Result<CellOutcome> + Sync,
{
    if threads <= 1 || cells.len() <= 1 {
        return cells.iter().map(|(key, stops)| build(key, stops)).collect();
    }
    let mut order: Vec<usize> = (0..cells.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(weights[i]));
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let mut results: Vec<(usize, Result<CellOutcome>)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads.min(cells.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut mine = Vec::new();
                    while !failed.load(Ordering::Relaxed) {
                        let Some(&i) = order.get(next.fetch_add(1, Ordering::Relaxed)) else {
                            break;
                        };
                        let (key, stops) = &cells[i];
                        let r = build(key, stops);
                        if r.is_err() {
                            failed.store(true, Ordering::Relaxed);
                        }
                        mine.push((i, r));
                    }
                    mine
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|w| w.join().unwrap_or_else(|p| std::panic::resume_unwind(p)))
            .collect()
    });
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, r)| r).collect()
}

#[allow(clippy::too_many_arguments)]
fn build_one_cell(
    inputs: &TileInputs,
    bundle_hash: &str,
    city_id: &str,
    cap: usize,
    max_depth: usize,
    compressor: &dyn TileCompressor,
    tile_sub_dir: &Path,
    cell_key: &str,
    cell_stops: &[usize],
) -> Result<CellOutcome> {
    let tile = build_tile_for_cell(
        inputs,
        cell_stops,
        bundle_hash,
        city_id,
        super::grid::SCHEDULE_TILE_EDGE_METERS,
    );
    let json = encode_schedule_tile(&tile);
    let compressed = compressor.compress(&json);
    let whole_cell = |bytes: &[u8], oversized: bool| -> Result<CellOutcome> {
        std::fs::write(tile_sub_dir.join(format!("{cell_key}.br")), bytes)?;
        Ok(CellOutcome {
            tiles_written: 1,
            stop_coords: cell_stops
                .iter()
                .map(|&si| (inputs.stops[si].id.clone(), cell_key.to_string()))
                .collect(),
            plans: None,
            max_depth: 0,
            oversized_leaves: u32::from(oversized),
            max_leaf_bytes: bytes.len(),
        })
    };
    if compressed.len() <= cap {
        return whole_cell(&compressed, false);
    }
    // Over-cap: subdivide (root bytes reused, not recompressed). Only the
    // root's length is needed from here on, so free its JSON before the
    // quadtree builds and compresses the leaves.
    let (x, y) = parse_cell_key(cell_key)?;
    let uncompressed = json.len();
    drop(json);
    let leaves = subdivide_cell(
        SubdivideArgs {
            inputs,
            cell_stops,
            bundle_hash,
            city_id,
            cell_x: x,
            cell_y: y,
            precompressed_root: Some(Precompressed {
                compressed_bytes: compressed.len(),
                uncompressed,
                bytes: compressed,
            }),
        },
        cap,
        max_depth,
        compressor,
    );
    if leaves.len() == 1 && leaves[0].suffix.is_empty() {
        // Irreducible oversized cell: bare name, NO subdivisions entry,
        // still counted oversized (degradation gauge parity).
        let only = &leaves[0];
        return whole_cell(&only.bytes, only.oversized);
    }
    let mut outcome = CellOutcome {
        tiles_written: 0,
        stop_coords: Vec::new(),
        plans: None,
        max_depth: 0,
        oversized_leaves: 0,
        max_leaf_bytes: 0,
    };
    let mut plans = Vec::with_capacity(leaves.len());
    for leaf in &leaves {
        let leaf_coords = format!("{cell_key}-{}", leaf.suffix);
        std::fs::write(tile_sub_dir.join(format!("{leaf_coords}.br")), &leaf.bytes)?;
        for &si in &leaf.stops {
            outcome
                .stop_coords
                .push((inputs.stops[si].id.clone(), leaf_coords.clone()));
        }
        outcome.tiles_written += 1;
        let depth = if leaf.suffix.is_empty() {
            0
        } else {
            leaf.suffix.split('-').count() as u32
        };
        outcome.max_depth = outcome.max_depth.max(depth);
        if leaf.oversized {
            outcome.oversized_leaves += 1;
        }
        outcome.max_leaf_bytes = outcome.max_leaf_bytes.max(leaf.compressed_bytes);
        plans.push(LeafPlan {
            suffix: leaf.suffix.clone(),
            bbox: leaf.bbox,
            compressed_bytes: leaf.compressed_bytes,
            oversized: leaf.oversized,
        });
    }
    outcome.plans = Some(plans);
    Ok(outcome)
}

fn parse_cell_key(key: &str) -> Result<(i32, i32)> {
    let (x, y) = key
        .split_once('_')
        .ok_or_else(|| Error::Config(format!("bad cell key {key}")))?;
    Ok((
        x.parse()
            .map_err(|_| Error::Config(format!("bad cell key {key}")))?,
        y.parse()
            .map_err(|_| Error::Config(format!("bad cell key {key}")))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule_tiles::brotli_tile::Brotli;
    use crate::schedule_tiles::grid::schedule_cell_bounds;
    use crate::schedule_tiles::inputs::{TileRoute, TileService, TileStop, TileTrip};
    use std::collections::HashMap;

    struct Identity;
    impl TileCompressor for Identity {
        fn compress(&self, input: &[u8]) -> Vec<u8> {
            input.to_vec()
        }
    }

    fn quadrant_center(bbox: &Bbox, digit: u8) -> (f64, f64) {
        let child = super::super::grid::bisect_quadrant(bbox, digit);
        (
            (child.min_lat + child.max_lat) / 2.0,
            (child.min_lon + child.max_lon) / 2.0,
        )
    }

    /// Build a TileInputs with one cell containing `n` stops, one per
    /// quadrant (0..n, n<=4), each on its own distinct trip+route so the
    /// per-stop JSON contribution is independent.
    fn one_cell_inputs(cell_x: i32, cell_y: i32, n: usize) -> TileInputs {
        let bbox = schedule_cell_bounds(cell_x, cell_y);
        let mut stops = Vec::new();
        let mut routes = Vec::new();
        let mut trips = Vec::new();
        let mut stop_times = Vec::new();
        for i in 0..n {
            let (lat, lon) = quadrant_center(&bbox, i as u8);
            stops.push(TileStop {
                id: format!("S{i}"),
                lat,
                lon,
            });
            routes.push(TileRoute {
                route_id: format!("R{i}"),
                short_name: format!("{i}"),
                long_name: format!("Route {i}"),
                route_color: "FF0000".into(),
                route_type: 3,
            });
            trips.push(TileTrip {
                trip_id: format!("T{i}"),
                route_idx: i as u32,
                service_idx: 0,
                headsign: format!("Headsign {i}"),
            });
            stop_times.push((vec![i as u32], vec![28_800 + i as u32]));
        }
        TileInputs {
            stops,
            trips,
            routes,
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec![],
            }],
            stop_times,
            route_styles: HashMap::new(),
        }
    }

    /// Single-stop cell with many departures on one trip (used for the
    /// irreducible-oversized-cell test).
    fn single_stop_cell_inputs(cell_x: i32, cell_y: i32, departures: usize) -> TileInputs {
        let bbox = schedule_cell_bounds(cell_x, cell_y);
        let mid_lat = (bbox.min_lat + bbox.max_lat) / 2.0;
        let mid_lon = (bbox.min_lon + bbox.max_lon) / 2.0;
        let trip_col = vec![0u32; departures];
        let dep_col: Vec<u32> = (0..departures as u32).map(|i| 28_800 + i).collect();
        TileInputs {
            stops: vec![TileStop {
                id: "MEGA".into(),
                lat: mid_lat,
                lon: mid_lon,
            }],
            trips: vec![TileTrip {
                trip_id: "T0".into(),
                route_idx: 0,
                service_idx: 0,
                headsign: "H".into(),
            }],
            routes: vec![TileRoute {
                route_id: "R0".into(),
                short_name: "1".into(),
                long_name: "One".into(),
                route_color: "FF0000".into(),
                route_type: 3,
            }],
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec![],
            }],
            stop_times: vec![(trip_col, dep_col)],
            route_styles: HashMap::new(),
        }
    }

    #[test]
    fn under_cap_city_writes_bare_cell_files_and_full_stop_map() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = one_cell_inputs(10, 5, 4);
        let result = build_bundle(
            &inputs,
            "hash1",
            "city",
            dir.path(),
            10_000_000, // huge cap — nothing subdivides
            4,
            &Identity,
            1,
        )
        .expect("build_bundle succeeds");

        assert_eq!(result.tiles_written, 1);
        assert!(result.subdivisions.is_empty());
        assert_eq!(result.stats.cell_count, 1);
        assert_eq!(result.stats.subdivided_cells, 0);
        assert_eq!(result.stats.oversized_leaves, 0);

        let cell_key = "10_5";
        assert_eq!(result.stop_tile_coords.len(), 4);
        for i in 0..4 {
            assert_eq!(
                result
                    .stop_tile_coords
                    .get(&format!("S{i}"))
                    .map(String::as_str),
                Some(cell_key)
            );
        }

        let final_dir = dir.path().join("hash1");
        let tile_path = final_dir.join("6km").join(format!("{cell_key}.br"));
        assert!(tile_path.exists(), "bare cell tile written under final dir");
        assert!(!dir.path().join("hash1.tmp").exists());
        assert!(!dir.path().join("hash1.old").exists());
    }

    #[test]
    fn over_cap_cell_writes_leaf_files_and_records_subdivision_plan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = one_cell_inputs(10, 5, 4);
        let cell_stops: Vec<usize> = (0..4).collect();

        // Derive a cap forcing a split: below the whole-cell tile size but
        // above (or equal to) each quadrant's own tile size.
        let whole_len = {
            let tile = build_tile_for_cell(&inputs, &cell_stops, "hash2", "city", 6000);
            encode_schedule_tile(&tile).len()
        };
        let single_len = {
            let tile = build_tile_for_cell(&inputs, &[0usize], "hash2", "city", 6000);
            encode_schedule_tile(&tile).len()
        };
        let cap = single_len;
        assert!(whole_len > cap, "fixture must force a split");

        let result = build_bundle(&inputs, "hash2", "city", dir.path(), cap, 4, &Identity, 1)
            .expect("build_bundle succeeds");

        let cell_key = "10_5";
        assert!(result.subdivisions.contains_key(cell_key));
        let plans = &result.subdivisions[cell_key];
        assert_eq!(
            plans.len(),
            4,
            "one leaf per quadrant, none oversized nor merged"
        );
        assert_eq!(result.stats.subdivided_cells, 1);
        assert_eq!(result.tiles_written, 4);
        assert_eq!(result.stats.oversized_leaves, 0);
        assert!(result.stats.max_leaf_bytes > 0);

        let tile_sub_dir = dir.path().join("hash2").join("6km");
        for plan in plans {
            let leaf_path = tile_sub_dir.join(format!("{cell_key}-{}.br", plan.suffix));
            assert!(leaf_path.exists(), "leaf file {:?} missing", leaf_path);
            assert!(!plan.oversized);
            assert_eq!(
                plan.compressed_bytes,
                std::fs::metadata(&leaf_path).unwrap().len() as usize
            );
        }
        // stop_tile_coords maps each stop to its exact leaf coord.
        for i in 0..4 {
            let coord = result
                .stop_tile_coords
                .get(&format!("S{i}"))
                .unwrap_or_else(|| panic!("stop S{i} missing from stop_tile_coords"));
            assert_eq!(coord, &format!("{cell_key}-{i}"));
        }
    }

    #[test]
    fn irreducible_single_leaf_cell_uses_bare_name_with_no_subdivisions_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = single_stop_cell_inputs(10, 5, 50);

        let result = build_bundle(
            &inputs,
            "hash3",
            "city",
            dir.path(),
            1, // tiny cap — the single stop can never fit, never split (len 1)
            4,
            &Identity,
            1,
        )
        .expect("build_bundle succeeds");

        let cell_key = "10_5";
        assert!(
            !result.subdivisions.contains_key(cell_key),
            "irreducible single-leaf cell must NOT get a subdivisions entry"
        );
        assert_eq!(result.tiles_written, 1);
        assert_eq!(result.stats.oversized_leaves, 1);
        assert_eq!(
            result.stop_tile_coords.get("MEGA").map(String::as_str),
            Some(cell_key)
        );

        let bare_path = dir
            .path()
            .join("hash3")
            .join("6km")
            .join(format!("{cell_key}.br"));
        assert!(
            bare_path.exists(),
            "written under bare <cell>.br, not <cell>-.br"
        );
        let dashed_path = dir
            .path()
            .join("hash3")
            .join("6km")
            .join(format!("{cell_key}-.br"));
        assert!(!dashed_path.exists());
    }

    #[test]
    fn two_phase_swap_removes_stale_final_dir_contents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bundle_hash = "hash4";
        let final_dir = dir.path().join(bundle_hash);
        std::fs::create_dir_all(&final_dir).unwrap();
        std::fs::write(final_dir.join("stale.br"), b"stale").unwrap();

        let inputs = one_cell_inputs(10, 5, 1);
        build_bundle(
            &inputs,
            bundle_hash,
            "city",
            dir.path(),
            10_000_000,
            4,
            &Identity,
            1,
        )
        .expect("build_bundle succeeds");

        assert!(
            !final_dir.join("stale.br").exists(),
            "stale file from the previous bundle must be gone after the swap"
        );
        assert!(final_dir.join("6km").join("10_5.br").exists());
        assert!(!dir.path().join(format!("{bundle_hash}.tmp")).exists());
        assert!(!dir.path().join(format!("{bundle_hash}.old")).exists());
    }

    /// `n` stops in each of `cells`, one per quadrant, every stop on its own
    /// trip and route, so cells differ in size and some split under a cap.
    fn multi_cell_inputs(cells: &[(i32, i32, usize)]) -> TileInputs {
        let mut inputs = one_cell_inputs(0, 0, 0);
        for &(x, y, n) in cells {
            let bbox = schedule_cell_bounds(x, y);
            for q in 0..n {
                let i = inputs.stops.len();
                let (lat, lon) = quadrant_center(&bbox, q as u8);
                inputs.stops.push(TileStop {
                    id: format!("S{x}_{y}_{q}"),
                    lat,
                    lon,
                });
                inputs.routes.push(TileRoute {
                    route_id: format!("R{i}"),
                    short_name: format!("{i}"),
                    long_name: format!("Route {i}"),
                    route_color: "00FF00".into(),
                    route_type: 3,
                });
                inputs.trips.push(TileTrip {
                    trip_id: format!("T{i}"),
                    route_idx: i as u32,
                    service_idx: 0,
                    headsign: format!("Headsign {i}"),
                });
                inputs
                    .stop_times
                    .push((vec![i as u32; 3], vec![28_800, 30_600, 32_400]));
            }
        }
        inputs
    }

    fn tile_files(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    std::fs::read(e.path()).unwrap(),
                )
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn worker_threads_produce_the_sequential_bundle_byte_for_byte() {
        let cells: Vec<(i32, i32, usize)> = (0..24)
            .map(|i| (100 + i % 6, 200 + i / 6, 1 + (i as usize * 7) % 4))
            .collect();
        let inputs = multi_cell_inputs(&cells);
        // A cap one single-stop tile wide splits every multi-stop cell, so
        // the comparison covers bare cells and subdivided ones alike.
        let cap = {
            let tile = build_tile_for_cell(&inputs, &[0usize], "h", "city", 6000);
            Brotli { quality: 1 }
                .compress(&encode_schedule_tile(&tile))
                .len()
        };
        let build = |threads: usize| {
            let dir = tempfile::tempdir().expect("tempdir");
            let r = build_bundle(
                &inputs,
                "h",
                "city",
                dir.path(),
                cap,
                4,
                &Brotli { quality: 1 },
                threads,
            )
            .expect("build_bundle succeeds");
            (r, tile_files(&dir.path().join("h").join("6km")), dir)
        };
        let (seq, seq_files, _d1) = build(1);
        assert!(
            seq.stats.subdivided_cells > 0,
            "fixture must split some cells"
        );
        assert!(
            seq.stats.subdivided_cells < 24,
            "fixture must keep some cells bare"
        );
        for threads in [2, 4, 64] {
            let (par, par_files, _d2) = build(threads);
            assert_eq!(
                par_files, seq_files,
                "tile bytes differ at threads={threads}"
            );
            assert_eq!(par.tiles_written, seq.tiles_written);
            assert_eq!(
                par.stop_tile_coords.iter().collect::<Vec<_>>(),
                seq.stop_tile_coords.iter().collect::<Vec<_>>(),
                "stop-cell order differs at threads={threads}"
            );
            let plans = |r: &BuildBundleResult| {
                r.subdivisions
                    .iter()
                    .map(|(k, v)| {
                        let leaves: Vec<_> = v
                            .iter()
                            .map(|p| (p.suffix.clone(), p.compressed_bytes, p.oversized))
                            .collect();
                        (k.clone(), leaves)
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                plans(&par),
                plans(&seq),
                "subdivisions differ at threads={threads}"
            );
            assert_eq!(par.stats.subdivided_cells, seq.stats.subdivided_cells);
            assert_eq!(par.stats.max_depth, seq.stats.max_depth);
            assert_eq!(par.stats.oversized_leaves, seq.stats.oversized_leaves);
            assert_eq!(par.stats.max_leaf_bytes, seq.stats.max_leaf_bytes);
            assert_eq!(par.stats.cell_count, seq.stats.cell_count);
        }
    }
}
