//! cargo run --release -p pt-walk --example bench_routes -- <city.ptwg> [file.ptwg.br]
//!
//! Prints one JSON line: decode/index time, heap size, allocation peak, and
//! route latency over 1000 deterministic pseudo-random pairs at most 1.5 km
//! apart, each endpoint nudged ~11 m off its node so snapping is exercised.
//!
//! `heap_bytes` is the index's own count. `live_alloc_bytes` and
//! `peak_alloc_bytes` come from a counting global allocator (this example
//! only): what is live once the index is built and the file buffer dropped,
//! and the high-water mark of decode + index build, file buffer included.
//!
//! After the JSON line it prints one `PASS`/`FAIL` line per gate (see
//! `GATES` below) and exits non-zero if any gate fails. The `.br` file is
//! needed for the brotli gate; without it that gate fails.
//!
//! Pairs are sampled by point index, junctions first since PTWG v2, so
//! `found` and the latencies are not comparable to runs before v2.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use pt_walk::format::decode;
use pt_walk::geo::dist;
use pt_walk::route::{Profile, WalkIndex};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grow(by: usize) {
    let now = LIVE.fetch_add(by, Relaxed) + by;
    PEAK.fetch_max(now, Relaxed);
}

// SAFETY: every call forwards to `System` unchanged; only counters are added.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        System.alloc(l)
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        System.alloc_zeroed(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if n > l.size() {
            grow(n - l.size());
        } else {
            LIVE.fetch_sub(l.size() - n, Relaxed);
        }
        System.realloc(p, l, n)
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

// GATES. Sizes are per point (`point_count`, the uncontracted node count)
// because cities differ in size: one absolute budget either fails the big
// cities or says nothing about the small ones. Measured at PTWG v2 (B/point):
// heap 26.8-27.8, peak 33.8-35.6, brotli 4.90-5.23.
//
// The peak covers the file buffer, which is live during decode. Decode is
// two-pass (count, then fill exactly sized arrays) to keep that peak down;
// the price is decode time (paris 34-43 ms before, 52-57 ms after), well
// inside what a one-off load can spend.
//
// `pt_walk::MAX_ARTIFACT_POINTS` caps any single artifact (the builder
// refuses larger cities) until the graph is tiled, so that RAM scales with
// the tiles in use instead of the whole city.
const HEAP_B_PER_POINT: f64 = 30.0;
const PEAK_B_PER_POINT: f64 = 38.0;
const BROTLI_B_PER_POINT: f64 = 5.5;
const P95_MAX_MS: f64 = 20.0;
const FOUND_MIN: usize = 900;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: bench_routes <city.ptwg> [city.ptwg.br]");
    let br_bytes = args
        .next()
        .map(|p| std::fs::metadata(p).expect("stat .br").len());
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let bytes = std::fs::read(&path).expect("read ptwg");
    let raw_bytes = bytes.len();

    let t = Instant::now();
    let graph = decode(&bytes).expect("decode");
    let decode_ms = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    let index = WalkIndex::new(graph).expect("index");
    let index_ms = t.elapsed().as_secs_f64() * 1e3;
    drop(bytes);
    let live_alloc = LIVE.load(Relaxed) - base;
    let peak_alloc = PEAK.load(Relaxed) - base;

    let g = index.graph();
    // Sample over every point (junctions, then chain interiors).
    let n = g.point_count() as u64;
    let proj = index.projection();
    let ll = |i: usize| {
        let (lat, lon) = g.point_e7(i);
        (f64::from(lat) / 1e7, f64::from(lon) / 1e7)
    };
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };

    let mut times = Vec::with_capacity(1000);
    let mut found = 0usize;
    for _ in 0..1000 {
        let a = (next() % n) as usize;
        let (alat, alon) = ll(a);
        let mut b = a;
        for _ in 0..200 {
            let c = (next() % n) as usize;
            let (clat, clon) = ll(c);
            if dist(proj.project(alat, alon), proj.project(clat, clon)) <= 1500.0 && c != a {
                b = c;
                break;
            }
        }
        let (blat, blon) = ll(b);
        let t = Instant::now();
        let r = index.route(
            (alat + 0.0001, alon),
            (blat - 0.0001, blon),
            Profile::Default,
        );
        times.push(t.elapsed().as_secs_f64() * 1e3);
        found += usize::from(r.is_some());
    }
    times.sort_by(f64::total_cmp);
    let pct = |p: f64| times[((times.len() as f64 - 1.0) * p).round() as usize];
    println!(
        "{{\"city\":\"{}\",\"nodes\":{},\"edges\":{},\"junctions\":{},\"chains\":{},\"raw_bytes\":{},\"brotli_bytes\":{},\"decode_ms\":{:.1},\"index_ms\":{:.1},\"heap_bytes\":{},\"live_alloc_bytes\":{},\"peak_alloc_bytes\":{},\"routes\":{},\"found\":{},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"max_ms\":{:.3}}}",
        g.meta().city_id, g.point_count(), g.segment_count(), g.junction_count(), g.chain_count(), raw_bytes,
        br_bytes.map_or("null".to_string(), |b| b.to_string()),
        decode_ms, index_ms, index.heap_bytes(), live_alloc, peak_alloc,
        times.len(), found, pct(0.5), pct(0.95), pct(1.0)
    );

    let points = g.point_count();
    let per_point = |b: f64| b * points as f64;
    let mut failed = false;
    let mut gate = |name: &str, ok: bool, detail: String| {
        println!("{} {name}: {detail}", if ok { "PASS" } else { "FAIL" });
        failed |= !ok;
    };
    let (heap, peak) = (index.heap_bytes() as f64, peak_alloc as f64);
    gate(
        "points",
        points <= pt_walk::MAX_ARTIFACT_POINTS,
        format!("{points} (limit {})", pt_walk::MAX_ARTIFACT_POINTS),
    );
    gate(
        "heap",
        heap <= per_point(HEAP_B_PER_POINT),
        format!(
            "{:.1} B/point (limit {HEAP_B_PER_POINT})",
            heap / points as f64
        ),
    );
    gate(
        "peak_alloc",
        peak <= per_point(PEAK_B_PER_POINT),
        format!(
            "{:.1} B/point (limit {PEAK_B_PER_POINT})",
            peak / points as f64
        ),
    );
    match br_bytes {
        Some(br) => gate(
            "brotli",
            br as f64 <= per_point(BROTLI_B_PER_POINT),
            format!(
                "{:.2} B/point (limit {BROTLI_B_PER_POINT})",
                br as f64 / points as f64
            ),
        ),
        None => gate("brotli", false, "not measured: pass the .br file".into()),
    }
    let p95 = pct(0.95);
    gate(
        "p95",
        p95 <= P95_MAX_MS,
        format!("{p95:.3} ms (limit {P95_MAX_MS})"),
    );
    gate(
        "found",
        found >= FOUND_MIN,
        format!("{found}/{} (minimum {FOUND_MIN})", times.len()),
    );
    if failed {
        std::process::exit(1);
    }
}
