//! Port of routeTypeToMode (packages/shared/src/ptb/ptbToBundleWire.ts:66).
//! GTFS route_type → wire mode string. Extended ranges follow the TS mapping
//! exactly (it is the wire contract, not the GTFS spec's richer taxonomy).
//! GTFS reference: https://gtfs.org/documentation/schedule/reference/#routestxt

pub fn route_type_to_mode(route_type: u16) -> &'static str {
    match route_type {
        0 => "TRAM",
        1 => "METRO",
        2 => "RAIL",
        3 => "BUS",
        4 => "FERRY",
        5 => "CABLE_TRAM",
        6 => "AERIAL",
        7 => "FUNICULAR",
        11 => "TROLLEYBUS",
        12 => "METRO",
        100..=199 => "RAIL",
        200..=299 => "BUS",
        400..=499 => "METRO",
        700..=799 => "BUS",
        800..=899 => "TROLLEYBUS",
        900..=999 => "TRAM",
        1000..=1099 => "FERRY",
        1100..=1199 => "OTHER", // air — no transit analog
        1200..=1299 => "FERRY",
        1300..=1399 => "AERIAL",
        1400..=1499 => "FUNICULAR",
        1500..=1599 => "OTHER", // taxi
        1700..=1799 => "OTHER", // misc
        _ => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::route_type_to_mode;
    #[test]
    fn matches_ts_table() {
        assert_eq!(route_type_to_mode(3), "BUS");
        assert_eq!(route_type_to_mode(11), "TROLLEYBUS");
        assert_eq!(route_type_to_mode(12), "METRO");
        assert_eq!(route_type_to_mode(109), "RAIL");
        assert_eq!(route_type_to_mode(715), "BUS");
        assert_eq!(route_type_to_mode(1105), "OTHER");
        assert_eq!(route_type_to_mode(9999), "OTHER");
    }
}
