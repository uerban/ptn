//! Engine-owned RAPTOR regression suite over the committed `.ptb` corpus.
//!
//! Runs the pinned query corpus (`raptor_corpus.rs`) through the PRODUCTION
//! read + route path — `Reader::from_bytes` → `Index::build` → `plan` →
//! `project` — under all three `PatternMode`s, and pins the result three ways:
//!
//!  1. **Full-itinerary golden.** Every (tuple × mode) record is serialised to
//!     the canonical projection JSON and compared against the committed
//!     `golden/raptor-plan.golden.tsv`. Every leg field and the ARRAY ORDER of
//!     both legs and itineraries are inside the compared string, so any
//!     behaviour change surfaces as a named record diff.
//!  2. **Hand-checked expectations.** Independently of the golden, each tuple
//!     asserts its literal expectations from `raptor_corpus.rs`: the
//!     empty/non-empty verdict, the first transit leg's `(route_id, board_pos,
//!     alight_pos)`, the first itinerary's `(board_secs, alight_secs)` (the
//!     overnight −86400 rewrite), and the first transit leg's
//!     `(depart, arrive, approximate)`. A golden regenerated over changed
//!     behaviour still fails here.
//!  3. **Raw-recompute coverage oracle.** Under the two ON modes, the set of
//!     GTFS route ordinals the index exposes at each stop must equal the set
//!     recomputed straight from `route_trips` + `trip_starts` + the `StopTimes`
//!     rows, WITHOUT reading the stop→routes CSR the index builds from. This
//!     proves the pattern grouping covers every trip's stops, not just the
//!     canonical sequence, and (being grouping-invariant) that `CoveringMerge`
//!     covers exactly the same stops as `Unbounded`.
//!  4. **Pattern-enumeration golden.** The per-stop scan index itself —
//!     `Index::derived_routes_at_stop()` per fixture per mode, ascending stop
//!     order, per-stop list in scan order — is pinned in
//!     `golden/pattern-routes-at-stop.golden.tsv`. Two groupings can agree on
//!     every itinerary in this corpus and still differ in pattern count or
//!     order; that difference changes the equal-arrival tie-break on any other
//!     feed, so it is pinned directly rather than inferred.
//!  5. **Whole-window service-day oracle.** `Reader::service_active_on` is
//!     checked against the raw per-service bitmask bit for EVERY day of each
//!     bundle's runtime window (up to 400 days), stepping the date with civil
//!     arithmetic implemented here rather than the reader's own. Both window
//!     boundaries are pinned inactive. The routing corpus only samples a
//!     handful of dates; this covers the rest.
//!
//! Regenerating either golden is deliberately awkward and never happens in CI:
//! set `PT_UPDATE_GOLDEN=1` to rewrite them, then review the diff. CI runs
//! without the variable, so a behaviour change fails instead of self-healing.
//!
//! Emits machine-checkable summary lines, one per mode per golden, which the
//! `pt-core-engine-regression` CI job greps:
//!   `raptor-golden: <N> records compared (<mode>), <M> mismatch`
//!   `raptor-pattern-golden: <N> records compared (<mode>), <M> mismatch`

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use pt_core::{
    plan, project, Index, Mobility, PatternMode, ProjectedLeg, Query, Reader, ScanState, StopWalk,
    Transfers,
};

mod raptor_corpus;
use raptor_corpus::{Tuple, TUPLES};

/// The three `PatternMode`s, paired with the CLI/wire spelling used as the
/// golden's mode key and in the summary lines.
const MODES: [(&str, PatternMode); 3] = [
    ("off", PatternMode::Off),
    ("unbounded", PatternMode::Unbounded),
    ("covering-merge", PatternMode::CoveringMerge),
];

const GOLDEN_REL: &str = "crates/pt-core/tests/golden/raptor-plan.golden.tsv";

/// Provenance banner rewritten verbatim whenever the golden is regenerated, so
/// the committed file documents how to reproduce itself.
const GOLDEN_HEADER: &str = "\
# Committed golden for crates/pt-core/tests/raptor_behavior.rs.
#
# One TAB-separated record per (tuple x PatternMode), in corpus order, modes in
# the order off, unbounded, covering-merge. Fields:
#   1 tuple name
#   2 pattern mode (off | unbounded | covering-merge)
#   3 repo-relative .ptb path
#   4 repo-relative PTFT transfers.bin path, or empty
#   5 query JSON (engine-neutral; the wasm runner rebuilds its query from it)
#   6 projected itineraries JSON, canonical key order
#
# Produced ONLY by:  PT_UPDATE_GOLDEN=1 cargo test -p pt-core --test raptor_behavior
# Deterministic: no clock, no RNG, no map-iteration order in the output.
# CI never sets PT_UPDATE_GOLDEN, so a behaviour change fails the gate instead
# of silently rewriting this file.
#
# Also consumed by crates/pt-wasm/tests/plan_golden.mjs, which replays field 5
# through the pt-wasm PtRouter binding and compares against field 6.
";

const PATTERN_GOLDEN_REL: &str = "crates/pt-core/tests/golden/pattern-routes-at-stop.golden.tsv";

const PATTERN_GOLDEN_HEADER: &str = "\
# Committed golden for crates/pt-core/tests/raptor_behavior.rs.
#
# The per-stop scan index the RAPTOR round loop walks, one TAB-separated record
# per (fixture x PatternMode), fixtures in ascending path order, modes in the
# order off, unbounded, covering-merge. Fields:
#   1 repo-relative .ptb path
#   2 pattern mode (off | unbounded | covering-merge)
#   3 Index::derived_routes_at_stop() as
#     {\"<stop_idx>\":[[pattern_idx,reader_route_idx],...],...}, ascending stop
#     order, per-stop list in SCAN order
#
# Produced ONLY by:  PT_UPDATE_GOLDEN=1 cargo test -p pt-core --test raptor_behavior
# Fixtures explicitly marked band-only carry no off record.
";

/// Walk up from this crate's manifest dir to the worktree root (the directory
/// holding `packages/`), so the suite locates the committed fixtures no matter
/// where the runner is invoked from.
fn repo_root() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..8 {
        if dir
            .join("packages/shared/src/ptb/__fixtures__/tiny.ptb")
            .exists()
        {
            return dir;
        }
        dir = dir
            .parent()
            .expect("walked past the filesystem root")
            .to_path_buf();
    }
    panic!(
        "could not locate the worktree root from {}",
        env!("CARGO_MANIFEST_DIR")
    );
}

fn mobility_of(name: &str) -> Mobility {
    match name {
        "wheelchair" => Mobility::Wheelchair,
        "bicycle" => Mobility::Bicycle,
        "default" => Mobility::Default,
        other => panic!("unknown mobility profile in corpus: {other}"),
    }
}

// ── canonical JSON emission ──────────────────────────────────────────────────
//
// Hand-rolled rather than pulled from a serialiser crate: `pt-core` has no
// dev-dependencies and the golden's value is that its key order is fixed by
// this code, not by a derive. Mirrors `pt-core-emit`'s `itineraries_to_json`
// so a golden record reads the same as that binary's stdout.

fn push_json_string(out: &mut String, val: &str) {
    out.push('"');
    for c in val.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn push_str_field(out: &mut String, key: &str, val: &str) {
    out.push(',');
    push_json_string(out, key);
    out.push(':');
    push_json_string(out, val);
}

fn push_int_field(out: &mut String, key: &str, val: i64) {
    out.push(',');
    push_json_string(out, key);
    out.push(':');
    out.push_str(&val.to_string());
}

/// The engine-neutral query JSON stored in the golden. `pt-wasm`'s runner
/// rebuilds its `WasmQuery` from exactly these fields, so the two engines
/// provably answer the SAME question over the same bytes.
fn query_json(t: &Tuple) -> String {
    let mut s = String::from("{\"entryStops\":[");
    for (i, (stop_id, walk)) in t.entry.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"stopId\":");
        push_json_string(&mut s, stop_id);
        s.push_str(",\"walkSecs\":");
        s.push_str(&walk.to_string());
        s.push('}');
    }
    s.push_str("],\"exitStops\":[");
    for (i, (stop_id, walk)) in t.exit.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"stopId\":");
        push_json_string(&mut s, stop_id);
        s.push_str(",\"walkSecs\":");
        s.push_str(&walk.to_string());
        s.push('}');
    }
    s.push_str("],\"departureSecs\":");
    s.push_str(&t.departure_secs.to_string());
    s.push_str(",\"date\":");
    s.push_str(&t.date.to_string());
    s.push_str(",\"maxRounds\":");
    match t.max_rounds {
        Some(r) => s.push_str(&r.to_string()),
        None => s.push_str("null"),
    }
    s.push_str(",\"mobilityProfile\":");
    push_json_string(&mut s, t.mobility);
    s.push_str(",\"excludedRouteTypes\":[");
    for (i, rt) in t.excluded_route_types.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&rt.to_string());
    }
    s.push(']');
    if !t.excluded_route_ids.is_empty() {
        s.push_str(",\"excludedRouteIds\":[");
        for (i, id) in t.excluded_route_ids.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            push_json_string(&mut s, id);
        }
        s.push(']');
    }
    s.push('}');
    s
}

fn itineraries_json(itins: &[pt_core::ProjectedItinerary]) -> String {
    let mut s = String::from("[");
    for (i, itin) in itins.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"legs\":[");
        for (j, leg) in itin.legs.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            match leg {
                ProjectedLeg::Walk(w) => {
                    s.push_str("{\"type\":\"walk\"");
                    push_str_field(&mut s, "mode", w.mode);
                    push_str_field(&mut s, "fromStopId", &w.from_stop_id);
                    push_str_field(&mut s, "toStopId", &w.to_stop_id);
                    push_int_field(&mut s, "departSecs", w.depart_secs);
                    push_int_field(&mut s, "arriveSecs", w.arrive_secs);
                    s.push('}');
                }
                ProjectedLeg::Transit(t) => {
                    s.push_str("{\"type\":\"transit\"");
                    push_str_field(&mut s, "mode", t.mode);
                    push_str_field(&mut s, "fromStopId", &t.from_stop_id);
                    push_str_field(&mut s, "toStopId", &t.to_stop_id);
                    push_int_field(&mut s, "departSecs", t.depart_secs);
                    push_int_field(&mut s, "arriveSecs", t.arrive_secs);
                    push_str_field(&mut s, "routeId", &t.route_id);
                    push_str_field(&mut s, "tripId", &t.trip_id);
                    push_int_field(&mut s, "boardStopIdx", t.board_stop_idx as i64);
                    push_int_field(&mut s, "alightStopIdx", t.alight_stop_idx as i64);
                    push_int_field(&mut s, "intermediateStops", t.intermediate_stops as i64);
                    if t.approximate {
                        s.push_str(",\"approximate\":true");
                    }
                    s.push('}');
                }
            }
        }
        s.push(']');
        push_int_field(&mut s, "boardSecs", itin.board_secs);
        push_int_field(&mut s, "alightSecs", itin.alight_secs);
        push_int_field(&mut s, "transfers", itin.transfers as i64);
        s.push('}');
    }
    s.push(']');
    s
}

// ── running the corpus ───────────────────────────────────────────────────────

/// One (tuple × mode) run: the projected result plus its golden line.
struct Record {
    tuple_idx: usize,
    mode_key: &'static str,
    itins: Vec<pt_core::ProjectedItinerary>,
    line: String,
}

/// A tuple runs under `Off` unless the corpus explicitly marks it band-only.
fn runs_in_mode(t: &Tuple, mode_key: &str) -> bool {
    !(t.band_only && mode_key == "off")
}

fn run_corpus(root: &Path) -> Vec<Record> {
    let mut out = Vec::new();
    for (mode_key, mode) in MODES {
        for (tuple_idx, t) in TUPLES.iter().enumerate() {
            if !runs_in_mode(t, mode_key) {
                continue;
            }
            let ptb_path = root.join(t.ptb);
            let bytes = fs::read(&ptb_path)
                .unwrap_or_else(|e| panic!("{}: read {}: {e}", t.name, ptb_path.display()));
            let reader = Reader::from_bytes(bytes)
                .unwrap_or_else(|e| panic!("{}: ptb decode: {e:?}", t.name));

            let transfers_bytes = t.transfers.map(|rel| {
                fs::read(root.join(rel)).unwrap_or_else(|e| panic!("{}: read {rel}: {e}", t.name))
            });
            let transfers = transfers_bytes.as_ref().map(|b| {
                Transfers::from_bytes(b)
                    .unwrap_or_else(|e| panic!("{}: transfers decode: {e:?}", t.name))
            });

            let resolve = |set: &[(&str, u32)]| -> Vec<StopWalk> {
                set.iter()
                    .map(|(stop_id, walk_secs)| StopWalk {
                        stop: reader.stop_index(stop_id).unwrap_or_else(|| {
                            panic!("{}: unknown stop id {stop_id} in {}", t.name, t.ptb)
                        }),
                        walk_secs: *walk_secs,
                    })
                    .collect()
            };
            let query = Query {
                excluded_routes: t
                    .excluded_route_ids
                    .iter()
                    .map(|id| {
                        (0..reader.num_routes())
                            .find(|&i| reader.route(i).unwrap().route_id == *id)
                            .unwrap() as u32
                    })
                    .collect(),
                entry_stops: resolve(t.entry),
                exit_stops: resolve(t.exit),
                departure_secs: t.departure_secs,
                date: t.date,
                max_rounds: t.max_rounds,
                mobility: mobility_of(t.mobility),
                excluded_modes: t.excluded_route_types.to_vec(),
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };

            let index = Index::build(&reader, mode)
                .unwrap_or_else(|e| panic!("{} [{mode_key}]: index build: {e:?}", t.name));
            let mut st = ScanState::default();
            let itins = plan(&reader, &index, transfers.as_ref(), &mut st, &query)
                .unwrap_or_else(|e| panic!("{} [{mode_key}]: plan: {e:?}", t.name));
            let projected = project(&reader, &itins)
                .unwrap_or_else(|e| panic!("{} [{mode_key}]: project: {e:?}", t.name));

            let line = format!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                t.name,
                mode_key,
                t.ptb,
                t.transfers.unwrap_or(""),
                query_json(t),
                itineraries_json(&projected),
            );
            out.push(Record {
                tuple_idx,
                mode_key,
                itins: projected,
                line,
            });
        }
    }
    out
}

fn golden_lines(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .collect()
}

/// Compare `records` — `(mode_key, label, line)`, already in a deterministic
/// order — against the committed golden at `rel`, and emit one
/// `<summary_prefix>: <N> records compared (<mode>), <M> mismatch` line per
/// mode. Rewrites the file instead of comparing when `PT_UPDATE_GOLDEN=1`, then
/// fails so a regeneration run can never be mistaken for a passing gate.
fn check_golden(
    root: &Path,
    rel: &str,
    header: &str,
    summary_prefix: &str,
    records: &[(&'static str, String, String)],
) {
    assert!(!records.is_empty(), "{rel}: empty record set must not pass");
    let golden_path = root.join(rel);
    let rendered = {
        let mut s = String::from(header);
        for (_, _, line) in records {
            s.push_str(line);
            s.push('\n');
        }
        s
    };

    if std::env::var("PT_UPDATE_GOLDEN").as_deref() == Ok("1") {
        fs::create_dir_all(golden_path.parent().expect("golden dir")).expect("create golden dir");
        fs::write(&golden_path, &rendered).expect("write golden");
        panic!("golden REWRITTEN at {rel} — re-run without PT_UPDATE_GOLDEN and review the diff");
    }

    let existing = fs::read_to_string(&golden_path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Regenerate with: PT_UPDATE_GOLDEN=1 cargo test -p pt-core --test raptor_behavior",
            golden_path.display()
        )
    });
    let expected = golden_lines(&existing);
    assert_eq!(
        expected.len(),
        records.len(),
        "{rel}: golden record count {} != produced count {} — the corpus changed; regenerate with PT_UPDATE_GOLDEN=1 and review",
        expected.len(),
        records.len(),
    );

    // Per-mode counters so each mode gets its own machine-checkable line.
    let mut compared: BTreeMap<&str, usize> = BTreeMap::new();
    let mut mismatch: BTreeMap<&str, usize> = BTreeMap::new();
    let mut first_failure: Option<String> = None;
    for ((mode_key, label, line), want) in records.iter().zip(expected.iter()) {
        *compared.entry(*mode_key).or_default() += 1;
        if line != want {
            *mismatch.entry(*mode_key).or_default() += 1;
            if first_failure.is_none() {
                first_failure = Some(format!(
                    "{rel}: golden mismatch for {label} [{mode_key}]\n  expected: {want}\n  actual:   {line}"
                ));
            }
        }
    }

    for (mode_key, _) in MODES {
        let n = compared.get(mode_key).copied().unwrap_or(0);
        let m = mismatch.get(mode_key).copied().unwrap_or(0);
        println!("{summary_prefix}: {n} records compared ({mode_key}), {m} mismatch");
        assert!(
            n > 0,
            "{rel}: mode {mode_key} compared 0 records — an empty set must not pass"
        );
    }
    if let Some(msg) = first_failure {
        panic!("{msg}");
    }
}

#[test]
fn projected_itineraries_match_the_committed_golden() {
    let root = repo_root();
    let records: Vec<(&'static str, String, String)> = run_corpus(&root)
        .into_iter()
        .map(|r| {
            (
                r.mode_key,
                TUPLES[r.tuple_idx].name.to_string(),
                r.line.clone(),
            )
        })
        .collect();
    check_golden(&root, GOLDEN_REL, GOLDEN_HEADER, "raptor-golden", &records);
}

/// Pattern-enumeration golden — the engine-side replacement for the
/// differential harness's `patternsAtStop` engine-vs-engine equality check.
///
/// `Index::derived_routes_at_stop()` is the per-stop scan index the RAPTOR
/// round loop walks: which patterns are examined at a stop, paired with the
/// GTFS route each came from, in SCAN ORDER. Pinning it per fixture per mode
/// catches a grouping regression that the itinerary golden can miss — two
/// enumerations can produce identical itineraries on this corpus yet differ in
/// pattern count or order, which changes the equal-arrival tie-break on any
/// other feed.
///
/// Complements `on_mode_index_covers_every_trips_stops`: that one proves
/// COVERAGE against a raw recompute (and is grouping-invariant by construction);
/// this one proves the grouping and its ORDER are exactly what was reviewed.
#[test]
fn pattern_enumeration_matches_the_committed_golden() {
    let root = repo_root();
    let mut fixtures: Vec<&str> = TUPLES.iter().map(|t| t.ptb).collect();
    fixtures.sort_unstable();
    fixtures.dedup();
    // Mirror the per-tuple `band_only` skip in the itinerary golden.
    let band_only: BTreeSet<&str> = TUPLES
        .iter()
        .filter(|t| t.band_only)
        .map(|t| t.ptb)
        .collect();

    let mut records: Vec<(&'static str, String, String)> = Vec::new();
    for (mode_key, mode) in MODES {
        for rel in &fixtures {
            if mode_key == "off" && band_only.contains(rel) {
                continue;
            }
            let bytes = fs::read(root.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
            let reader =
                Reader::from_bytes(bytes).unwrap_or_else(|e| panic!("{rel}: ptb decode: {e:?}"));
            let index = Index::build(&reader, mode)
                .unwrap_or_else(|e| panic!("{rel} [{mode_key}]: index build: {e:?}"));

            // `{"<stop_idx>":[[pattern_idx,reader_route_idx],…],…}` in ascending
            // stop order, per-stop list in scan order — the same shape
            // `pt-core-emit pattern-routes-at-stop` prints.
            let mut json = String::from("{");
            for (i, (stop_idx, pairs)) in index.derived_routes_at_stop().iter().enumerate() {
                if i > 0 {
                    json.push(',');
                }
                push_json_string(&mut json, &stop_idx.to_string());
                json.push_str(":[");
                for (j, (pattern_idx, route_idx)) in pairs.iter().enumerate() {
                    if j > 0 {
                        json.push(',');
                    }
                    json.push_str(&format!("[{pattern_idx},{route_idx}]"));
                }
                json.push(']');
            }
            json.push('}');

            records.push((
                mode_key,
                (*rel).to_string(),
                format!("{rel}\t{mode_key}\t{json}"),
            ));
        }
    }

    check_golden(
        &root,
        PATTERN_GOLDEN_REL,
        PATTERN_GOLDEN_HEADER,
        "raptor-pattern-golden",
        &records,
    );
}

#[test]
fn pinned_expectations_hold_independently_of_the_golden() {
    let root = repo_root();
    let records = run_corpus(&root);
    let mut asserted = 0usize;

    for r in &records {
        let t = &TUPLES[r.tuple_idx];
        let label = format!("{} [{}]", t.name, r.mode_key);

        // Empty / non-empty verdict. Under `Off` a `multi_pattern` tuple targets
        // an off-canonical stop the canonical-only scan cannot reach, so its
        // emptiness is expected there and only the ON modes assert non-empty.
        if t.expect_non_empty {
            if !(r.mode_key == "off" && t.multi_pattern) {
                assert!(!r.itins.is_empty(), "{label}: expected a non-empty result");
                asserted += 1;
            }
        } else {
            assert!(r.itins.is_empty(), "{label}: expected an empty result");
            asserted += 1;
        }

        let first_transit = r.itins.first().and_then(|i| {
            i.legs.iter().find_map(|l| match l {
                ProjectedLeg::Transit(t) => Some(t),
                ProjectedLeg::Walk(_) => None,
            })
        });

        if let Some((route_id, board, alight)) = t.expect_first_leg {
            let applies = t
                .expect_first_leg_modes
                .map(|modes| modes.contains(&r.mode_key))
                .unwrap_or(true);
            if applies && !r.itins.is_empty() {
                let leg = first_transit
                    .unwrap_or_else(|| panic!("{label}: expected a first transit leg"));
                assert_eq!(
                    (
                        leg.route_id.as_str(),
                        leg.board_stop_idx,
                        leg.alight_stop_idx
                    ),
                    (route_id, board, alight),
                    "{label}: first transit leg (route_id, board_pos, alight_pos)",
                );
                asserted += 1;
            }
        }

        if let Some((board_secs, alight_secs)) = t.expect_board_alight_secs {
            if let Some(itin) = r.itins.first() {
                assert_eq!(
                    (itin.board_secs, itin.alight_secs),
                    (board_secs, alight_secs),
                    "{label}: first itinerary (board_secs, alight_secs)",
                );
                asserted += 1;
            }
        }

        if let Some((depart, arrive, approximate)) = t.expect_first_transit_timing {
            if !r.itins.is_empty() {
                let leg = first_transit
                    .unwrap_or_else(|| panic!("{label}: expected a first transit leg"));
                assert_eq!(
                    (leg.depart_secs, leg.arrive_secs, leg.approximate),
                    (depart, arrive, approximate),
                    "{label}: first transit leg (depart_secs, arrive_secs, approximate)",
                );
                asserted += 1;
            }
        }
    }

    println!("raptor-pinned: {asserted} literal expectations asserted");
    assert!(
        asserted > 0,
        "no pinned expectation ran — an empty set must not pass"
    );
}

/// Raw-recompute coverage oracle, ported from the differential harness's
/// `patternsAtStop` union check.
///
/// For every distinct fixture with a flat `StopTimes` carry, recompute
/// `stop_idx → {GTFS route ordinal}` from `route_trips` + `trip_starts` + the
/// `StopTimes` rows — never reading the stop→routes CSR the `Off` index is
/// built from — and require the ON-mode index to expose exactly that set at
/// exactly those stops. A pattern grouping that dropped an off-canonical stop
/// (the symptom a canonical-only scan has) fails here.
///
/// Keying the oracle by GTFS route ordinal makes it grouping-INVARIANT, so
/// running it under both ON modes also proves `CoveringMerge` reaches the same
/// stops as `Unbounded` — a folded short trip rides its covering pattern.
///
/// Carry-less bundles are excluded: they have no flat carry to recompute
/// from, and the band-vs-flat grouping cross-check is a separate, dedicated
/// oracle (`cargo test -p pt-core --features pattern-crosscheck`).
#[test]
fn on_mode_index_covers_every_trips_stops() {
    let root = repo_root();
    let mut fixtures: Vec<&str> = TUPLES.iter().map(|t| t.ptb).collect();
    fixtures.sort_unstable();
    fixtures.dedup();

    let mut checked = 0usize;
    for rel in fixtures {
        let bytes = fs::read(root.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
        let reader =
            Reader::from_bytes(bytes).unwrap_or_else(|e| panic!("{rel}: ptb decode: {e:?}"));
        if reader.is_carry_less_band() {
            continue;
        }

        // Oracle: every (route, trip, stop_time row) triple, straight from the
        // raw regions.
        let trip_starts = reader
            .trip_starts()
            .unwrap_or_else(|e| panic!("{rel}: trip_starts: {e:?}"))
            .to_vec();
        let mut oracle: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
        for r in 0..reader.num_routes() {
            let trips = reader
                .route_trips(r)
                .unwrap_or_else(|e| panic!("{rel}: route_trips({r}): {e:?}"));
            for &t in trips {
                let lo = trip_starts[t as usize] as usize;
                let hi = trip_starts[t as usize + 1] as usize;
                for row in lo..hi {
                    let st = reader
                        .stop_time(row)
                        .unwrap_or_else(|e| panic!("{rel}: stop_time({row}): {e:?}"));
                    oracle.entry(st.stop_idx).or_default().insert(r as u32);
                }
            }
        }

        for (mode_key, mode) in MODES {
            if mode_key == "off" {
                continue; // canonical-only by construction; not a coverage claim
            }
            let index = Index::build(&reader, mode)
                .unwrap_or_else(|e| panic!("{rel} [{mode_key}]: index build: {e:?}"));
            let mut derived: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
            for (stop_idx, pairs) in index.derived_routes_at_stop() {
                derived
                    .entry(stop_idx)
                    .or_default()
                    .extend(pairs.into_iter().map(|(_pattern_idx, route_idx)| route_idx));
            }
            assert_eq!(
                derived.keys().copied().collect::<Vec<_>>(),
                oracle.keys().copied().collect::<Vec<_>>(),
                "{rel} [{mode_key}]: served-stop set differs from the raw-recompute oracle",
            );
            for (stop_idx, want) in &oracle {
                assert_eq!(
                    derived.get(stop_idx),
                    Some(want),
                    "{rel} [{mode_key}]: route set at stop {stop_idx} differs from the raw-recompute oracle",
                );
            }
            checked += 1;
        }
    }

    println!("raptor-union-oracle: {checked} (fixture, mode) pairs checked");
    assert!(
        checked > 0,
        "oracle ran over 0 fixtures — an empty set must not pass"
    );
}

// ── whole-window service-day oracle ──────────────────────────────────────────
//
// Independent civil-date arithmetic, used to step a `YYYYMMDD` across the whole
// service window without calling the reader's own `days_add`. Proleptic
// Gregorian days-from-civil / civil-from-days (Howard Hinnant's algorithm),
// which is exact for every month length and leap year — the cases a day-offset
// mapping gets wrong silently.
//
// GTFS anchors service days to calendar dates, not instants: `calendar.txt`
// start/end dates and `calendar_dates.txt` exceptions are civil `YYYYMMDD`
// values, so the window walk must be civil-date arithmetic with no timezone or
// DST component. https://gtfs.org/documentation/schedule/reference/#calendartxt

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYYMMDD` + `n` days → `YYYYMMDD`, via the civil-date algorithm above.
fn ymd_add(ymd: u32, n: i64) -> u32 {
    let (y, m, d) = (
        (ymd / 10000) as i64,
        ((ymd % 10000) / 100) as i64,
        (ymd % 100) as i64,
    );
    let (y2, m2, d2) = civil_from_days(days_from_civil(y, m, d) + n);
    (y2 * 10000 + m2 * 100 + d2) as u32
}

/// Whole-window service-day fidelity, ported from the differential harness's
/// per-day active-set loop.
///
/// For every distinct fixture, every service, and every day in the bundle's
/// RUNTIME window (`window_days`, not a hardcoded 90), require
/// `Reader::service_active_on(service, date)` to equal bit `n` of that
/// service's bitmask — where `date` is stepped with the independent civil-date
/// arithmetic above, so a month-length or leap-year slip in the reader's
/// date→offset mapping diverges here instead of hiding on an unqueried day.
///
/// Also pins the two window boundaries the routing corpus never samples: the
/// day before `feed_start_date` and the day one past the window's end must both
/// resolve INACTIVE for every service, so an off-by-one that widened the window
/// (reading a neighbouring service's bitmask byte) fails loudly.
#[test]
fn service_resolution_matches_the_bitmask_across_the_whole_window() {
    let root = repo_root();
    let mut fixtures: Vec<&str> = TUPLES.iter().map(|t| t.ptb).collect();
    fixtures.sort_unstable();
    fixtures.dedup();

    let mut day_checks = 0usize;
    let mut widest_window = 0u16;
    for rel in fixtures {
        let bytes = fs::read(root.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
        let reader =
            Reader::from_bytes(bytes).unwrap_or_else(|e| panic!("{rel}: ptb decode: {e:?}"));
        let window = reader.window_days();
        widest_window = widest_window.max(window);
        let start = reader.feed_start_date();

        for s in 0..reader.num_services() {
            let mask = reader.service_bitmask(s);
            for n in 0..window as i64 {
                let date = ymd_add(start, n);
                let want = (mask[(n >> 3) as usize] >> (n & 7)) & 1 == 1;
                assert_eq!(
                    reader.service_active_on(s, date),
                    want,
                    "{rel}: service {s} on {date} (window day {n}) disagrees with its bitmask bit",
                );
                day_checks += 1;
            }
            for out_of_window in [ymd_add(start, -1), ymd_add(start, window as i64)] {
                assert!(
                    !reader.service_active_on(s, out_of_window),
                    "{rel}: service {s} resolves ACTIVE on {out_of_window}, outside the {window}-day window",
                );
                day_checks += 1;
            }
        }
    }

    println!("raptor-service-window: {day_checks} (service, day) resolutions checked; widest window {widest_window} days");
    // The corpus must keep at least one fixture whose runtime window is NOT the
    // historical 90-day default, or a mis-wired wide stride (a 400-day bundle
    // read with a 90-day per-service bitmask stride) passes every check above.
    assert!(
        widest_window > 90,
        "no committed fixture carries a runtime windowDays > 90 — the wide-stride path is ungated",
    );
}
