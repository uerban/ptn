//! B2 — the service-bitfield pool rides through the pt-serve seam.
//!
//! pt-serve links the `no_std` pt-core engine, which decodes + validates the
//! `0x15 ServiceBitfieldPool` + `0x16 ServiceToBitfield` pair. This test pins
//! that at the pt-serve seam via `/plan` through `Generation::from_paths` +
//! `pt_core::plan`: two bundles with the SAME topology and the SAME two-entry
//! pool (`[all-inactive, all-active]`) differ only in which pool entry service 0
//! maps to. Mapping to the active entry must route; mapping to the inactive one
//! must not. A reader that ignored `0x16` (or sliced the wrong entry) fails one
//! of the two.
//!
//! Fixture sourcing: `pt_core::engine::testkit::build_service_pool_ptb` is
//! reachable from pt-serve tests via the `pt-core` dev-dependency's `test-helpers`
//! feature (Cargo.toml `[dev-dependencies] pt-core = { features = ["test-helpers"] }`).
//! The bytes are written to a temp `.ptb` and mounted — no new dep-feature edge.

use pt_core::engine::testkit::{build_service_pool_ptb, ServicePoolSpec, SoaRoute, SoaStop};
use pt_core::{plan, Itinerary, Mobility, PatternMode, Query, ScanState, StopWalk};

/// Shared 5-stop, 2-trip branch topology. trip0 LOCAL [s0,s1,s2,s4];
/// trip1 BRANCH [s0,s1,s3,s4]. Both trips are route 0, service 0.
fn topology_stops() -> [SoaStop<'static>; 5] {
    let mk = |id: &'static str| SoaStop {
        id,
        name: "",
        lat: 0.0,
        lon: 0.0,
        parent: None,
        wheelchair: 0,
    };
    [mk("s0"), mk("s1"), mk("s2"), mk("s3"), mk("s4")]
}

fn topology_routes() -> [SoaRoute<'static>; 1] {
    [SoaRoute {
        id: "R0",
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3,
    }]
}

const TRIP0: &[(u16, u32, u32)] = &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)];
const TRIP1: &[(u16, u32, u32)] = &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)];

/// A bundle over the shared topology whose two-entry pool is
/// `[all-inactive, all-active]` and whose single service 0 maps to
/// `pool[service_pool_idx]`.
fn pool_bytes(service_pool_idx: u32) -> Vec<u8> {
    let s = pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS);
    let inactive = vec![0x00u8; s];
    let active = vec![0xFFu8; s];
    let pool: Vec<&[u8]> = vec![inactive.as_slice(), active.as_slice()];
    let s2b: [u32; 1] = [service_pool_idx];
    let spec = ServicePoolSpec {
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
        pool: &pool,
        service_to_bitfield: &s2b,
    };
    build_service_pool_ptb(
        &topology_stops(),
        &topology_routes(),
        &[TRIP0, TRIP1],
        &spec,
    )
}

fn write_temp_ptb(bytes: &[u8]) -> tempfile::NamedTempFile {
    use std::io::Write as _;
    let mut f = tempfile::Builder::new()
        .suffix(".ptb")
        .tempfile()
        .expect("create temp ptb");
    f.write_all(bytes).expect("write temp ptb");
    f.flush().expect("flush temp ptb");
    f
}

/// Query s0 -> s4, dep before trip0, on a day inside the all-active window.
fn query() -> Query {
    Query {
        excluded_routes: Default::default(),
        entry_stops: vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        exit_stops: vec![StopWalk {
            stop: 4,
            walk_secs: 0,
        }],
        departure_secs: 25000,
        date: 20260605,
        max_rounds: None,
        mobility: Mobility::Default,
        excluded_modes: vec![],
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    }
}

/// Run `plan` over a bundle mounted via the pt-serve `Generation::from_paths`
/// seam; return the projected itineraries for cross-bundle comparison.
fn plan_over(bytes: &[u8]) -> Vec<Itinerary> {
    let tmp = write_temp_ptb(bytes);
    let gen =
        pt_serve::Generation::from_paths(tmp.path(), None, "test".to_string(), PatternMode::Off)
            .expect("Generation::from_paths over testkit bundle");
    let mut st = ScanState::default();
    plan(&gen.reader, &gen.index, None, &mut st, &query()).expect("plan must succeed")
}

/// Service 0 mapped to the active pool entry routes s0->s4; mapped to the
/// inactive entry it does not. Only the `0x16` index differs between the two.
#[test]
fn service_pool_index_selects_the_bitfield() {
    let active = plan_over(&pool_bytes(1));
    let inactive = plan_over(&pool_bytes(0));
    assert!(
        !active.is_empty(),
        "service 0 -> active pool entry must route s0->s4"
    );
    assert!(
        inactive.is_empty(),
        "service 0 -> inactive pool entry must not route, got {inactive:?}"
    );
}
