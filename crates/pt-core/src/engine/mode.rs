//! Single source of truth: GTFS `route_type` → canonical `Mode`, and
//! `Mode` → UPPERCASE wire string. Covers GTFS basic 0–12 plus Google's
//! Extended GTFS Route Types proposal (100–1799). Total + never panics.
//! The Rust and TS renditions are pinned equal by the committed golden table
//! (`packages/shared/src/ptb/__fixtures__/route-type-mode.golden.txt`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Mode {
    Tram = 0,
    Metro = 1,
    Rail = 2,
    Bus = 3,
    Ferry = 4,
    CableTram = 5,
    Aerial = 6,
    Funicular = 7,
    Trolleybus = 8,
    Other = 9,
}

/// Map a GTFS `route_type` to its canonical `Mode`. Total; unknown / undefined
/// / out-of-range all fold to `Other`.
pub fn route_type_to_mode(route_type: u16) -> Mode {
    use Mode::*;
    match route_type {
        0 => Tram,
        1 => Metro,
        2 => Rail,
        3 => Bus,
        4 => Ferry,
        5 => CableTram,
        6 => Aerial,
        7 => Funicular,
        11 => Trolleybus,
        12 => Metro, // monorail → closest-map METRO
        100..=199 => Rail,
        200..=299 => Bus,   // coach
        400..=499 => Metro, // urban rail / metro / monorail
        700..=799 => Bus,
        800..=899 => Trolleybus,
        900..=999 => Tram,
        1000..=1099 => Ferry, // water transport
        1200..=1299 => Ferry,
        1300..=1399 => Aerial,
        1400..=1499 => Funicular,
        1100..=1199 => Other, // air — no transit analog
        1500..=1599 => Other, // taxi
        1700..=1799 => Other, // misc
        _ => Other,           // undefined 8–10, gap 13–99, 300s/500s/600s/1600s, >=1800
    }
}

/// Canonical UPPERCASE wire string. Exhaustive `match` (no wildcard): a new
/// `Mode` variant fails compilation here.
pub fn mode_to_wire_str(mode: Mode) -> &'static str {
    match mode {
        Mode::Tram => "TRAM",
        Mode::Metro => "METRO",
        Mode::Rail => "RAIL",
        Mode::Bus => "BUS",
        Mode::Ferry => "FERRY",
        Mode::CableTram => "CABLE_TRAM",
        Mode::Aerial => "AERIAL",
        Mode::Funicular => "FUNICULAR",
        Mode::Trolleybus => "TROLLEYBUS",
        Mode::Other => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(rt: u16) -> &'static str {
        mode_to_wire_str(route_type_to_mode(rt))
    }

    #[test]
    fn basic_and_flip_cases() {
        assert_eq!(s(0), "TRAM");
        assert_eq!(s(1), "METRO");
        assert_eq!(s(2), "RAIL");
        assert_eq!(s(3), "BUS");
        assert_eq!(s(4), "FERRY");
        assert_eq!(s(5), "CABLE_TRAM"); // was CABLE_CAR
        assert_eq!(s(6), "AERIAL"); // was CABLE_CAR
        assert_eq!(s(7), "FUNICULAR");
        assert_eq!(s(11), "TROLLEYBUS");
        assert_eq!(s(12), "METRO"); // was BUS (default)
    }

    #[test]
    fn extended_and_oslo() {
        assert_eq!(s(401), "METRO");
        assert_eq!(s(902), "TRAM");
        assert_eq!(s(1008), "FERRY");
        assert_eq!(s(704), "BUS");
    }

    #[test]
    fn other_bucket() {
        assert_eq!(s(1100), "OTHER"); // air
        assert_eq!(s(1500), "OTHER"); // taxi
        assert_eq!(s(1700), "OTHER"); // misc
        assert_eq!(s(8), "OTHER");
        assert_eq!(s(50), "OTHER"); // gap 13–99
        assert_eq!(s(350), "OTHER");
        assert_eq!(s(1800), "OTHER");
        assert_eq!(s(65535), "OTHER");
    }

    #[test]
    fn band_boundaries() {
        // band lower bounds
        assert_eq!(s(100), "RAIL");
        assert_eq!(s(400), "METRO");
        assert_eq!(s(700), "BUS");
        assert_eq!(s(800), "TROLLEYBUS");
        assert_eq!(s(900), "TRAM");
        assert_eq!(s(1000), "FERRY");
        assert_eq!(s(1100), "OTHER");
        assert_eq!(s(1400), "FUNICULAR");
        // 1600–1699 undefined gap → OTHER
        assert_eq!(s(1600), "OTHER");
        assert_eq!(s(1650), "OTHER");
        // first/last of each band + just-outside
        assert_eq!(s(199), "RAIL");
        assert_eq!(s(200), "BUS");
        assert_eq!(s(299), "BUS");
        assert_eq!(s(300), "OTHER");
        assert_eq!(s(499), "METRO");
        assert_eq!(s(500), "OTHER");
        assert_eq!(s(799), "BUS");
        assert_eq!(s(899), "TROLLEYBUS");
        assert_eq!(s(999), "TRAM");
        assert_eq!(s(1099), "FERRY");
        assert_eq!(s(1199), "OTHER");
        assert_eq!(s(1200), "FERRY"); // low edge of 2nd ferry band, just after 1100–1199→OTHER
        assert_eq!(s(1299), "FERRY");
        assert_eq!(s(1300), "AERIAL");
        assert_eq!(s(1399), "AERIAL");
        assert_eq!(s(1499), "FUNICULAR");
        assert_eq!(s(1599), "OTHER");
        assert_eq!(s(1799), "OTHER");
    }

    #[test]
    fn matches_committed_golden_table() {
        extern crate std;
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/src/ptb/__fixtures__/route-type-mode.golden.txt"
        );
        let golden = std::fs::read_to_string(path)
            .expect("golden table missing — run gen-route-type-mode-golden.mjs");
        let mut n = 0;
        for line in golden.lines() {
            let (rt, mode) = line.split_once(' ').expect("bad golden row");
            let rt: u16 = rt.parse().expect("bad rt");
            assert_eq!(mode_to_wire_str(route_type_to_mode(rt)), mode, "rt {rt}");
            n += 1;
        }
        assert_eq!(n, 1803, "golden row count drifted");
    }
}
