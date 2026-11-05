use crate::error::{Error, Result};
use crate::pass1::{StopAttrs, TripAttrs};
use crate::strpool::StringPool;

pub const TRIP_RECORD_BYTES: usize = 24; // idIdx | headsignIdx | routeIdx | serviceIdx u32 | wheelchair u8@16 | direction_id u8@17 | bikes_allowed u8@18 | reserved[19] | shapeIdIdx u32@20

fn put_u32(dest: &mut [u8], off: usize, v: u32) {
    dest[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

fn check_region(dest: &[u8], n: usize, record_size: usize, label: &str) -> Result<()> {
    let need = n * record_size;
    if dest.len() < need {
        return Err(Error::Config(format!(
            "{label}: region too small need={need} have={}",
            dest.len()
        )));
    }
    Ok(())
}

fn check_alignment(keys: usize, attrs: usize, label: &str) -> Result<()> {
    if keys != attrs {
        return Err(Error::Config(format!(
            "{label}: keys.len()={keys} != attrs.len()={attrs}"
        )));
    }
    Ok(())
}

/// TripsIntern record (24 B): idIdx | headsignIdx | routeIdx | serviceIdx u32 | wheelchair u8@16 | direction_id u8@17 | bikes_allowed u8@18 | reserved[19] | shapeIdIdx u32@20
pub fn write_trips_intern(
    dest: &mut [u8],
    keys: &[String],
    attrs: &[TripAttrs],
    pool: &StringPool,
) -> Result<()> {
    check_alignment(keys.len(), attrs.len(), "write_trips_intern")?;
    check_region(dest, keys.len(), TRIP_RECORD_BYTES, "write_trips_intern")?;
    for (i, key) in keys.iter().enumerate() {
        let off = i * TRIP_RECORD_BYTES;
        put_u32(dest, off, pool.index_of(key));
        put_u32(dest, off + 4, pool.index_of(&attrs[i].headsign));
        put_u32(dest, off + 8, attrs[i].route_idx);
        put_u32(dest, off + 12, attrs[i].service_idx);
        dest[off + 16] = attrs[i].wheelchair_accessible;
        dest[off + 17] = attrs[i].direction_id;
        dest[off + 18] = attrs[i].bikes_allowed; // byte 19 (reserved) stays 0 — zero-filled by caller
        put_u32(dest, off + 20, pool.index_of(&attrs[i].shape_id));
    }
    Ok(())
}

/// Tight byte length of the current `StopsSoA 0x40` region for `n` stops:
/// five 4-byte columns + one u8 column = `n * 21`.
pub const STOPS_SOA_BYTES_PER_STOP: usize = 4 * 5 + 1;

/// Write the current `StopsSoA 0x40` region. Column order is normative: all
/// four-byte columns first, followed by the `u8` column.
/// ```text
/// id_idx u32×N | name_idx u32×N | lat_e7 i32×N | lon_e7 i32×N | parent_idx u32×N | wheelchair u8×N
/// ```
/// Coords are quantized from `StopAttrs.lat/lon` **f64** via
/// `coord_quant::encode_{lat,lon}_e7` — BEFORE any `as f32` narrowing (the lossless
/// i32@1e7 representation). A coordinate outside
/// WGS84 returns `Err` (reject, not clamp). `parent_idx[i]` is the dense parent
/// column: `u32::MAX` means no parent.
pub fn write_stops_soa(
    dest: &mut [u8],
    keys: &[String],
    attrs: &[StopAttrs],
    parent_idx: &[u32],
    pool: &StringPool,
) -> Result<()> {
    use crate::coord_quant::{encode_lat_e7, encode_lon_e7};
    check_alignment(keys.len(), attrs.len(), "write_stops_soa")?;
    if parent_idx.len() != keys.len() {
        return Err(Error::Config(format!(
            "write_stops_soa: parent_idx.len()={} != stops={}",
            parent_idx.len(),
            keys.len()
        )));
    }
    let n = keys.len();
    if dest.len() < n * STOPS_SOA_BYTES_PER_STOP {
        return Err(Error::Config(format!(
            "write_stops_soa: region too small need={} have={}",
            n * STOPS_SOA_BYTES_PER_STOP,
            dest.len()
        )));
    }
    // Column base offsets (tight): id_idx@0, name_idx@4N, lat_e7@8N, lon_e7@12N,
    // parent_idx@16N, wheelchair@20N.
    let (id_base, name_base, lat_base, lon_base, parent_base, wheel_base) =
        (0, 4 * n, 8 * n, 12 * n, 16 * n, 20 * n);
    for (i, key) in keys.iter().enumerate() {
        put_u32(dest, id_base + i * 4, pool.index_of(key));
        put_u32(dest, name_base + i * 4, pool.index_of(&attrs[i].name));
        // f64 → i32@1e7, BEFORE any f32 narrowing.
        let lat_e7 = encode_lat_e7(attrs[i].lat).ok_or_else(|| {
            Error::Config(format!(
                "write_stops_soa: lat out of WGS84 range for {key}: {}",
                attrs[i].lat
            ))
        })?;
        let lon_e7 = encode_lon_e7(attrs[i].lon).ok_or_else(|| {
            Error::Config(format!(
                "write_stops_soa: lon out of WGS84 range for {key}: {}",
                attrs[i].lon
            ))
        })?;
        dest[lat_base + i * 4..lat_base + i * 4 + 4].copy_from_slice(&lat_e7.to_le_bytes());
        dest[lon_base + i * 4..lon_base + i * 4 + 4].copy_from_slice(&lon_e7.to_le_bytes());
        put_u32(dest, parent_base + i * 4, parent_idx[i]);
        dest[wheel_base + i] = attrs[i].wheelchair_boarding;
    }
    Ok(())
}

/// Tight byte length of the current `RoutesSoA 0x41` region for `m` routes:
/// six 4-byte columns + one u16 column = `m * 26`.
pub const ROUTES_SOA_BYTES_PER_ROUTE: usize = 4 * 6 + 2;

/// Write the current `RoutesSoA 0x41` region. Column order is normative: all six
/// four-byte columns first, with the u16
/// `route_type` LAST:
/// ```text
/// id_idx u32×M | agency_idx u32×M | short_idx u32×M | long_idx u32×M |
/// color_idx u32×M | text_idx u32×M | route_type u16×M
/// ```
/// Each `*_idx` column holds the `StringPool` index of the corresponding
/// `RouteAttrs` field (`id` = the route key). Total `m * 26` bytes.
pub fn write_routes_soa(
    dest: &mut [u8],
    keys: &[String],
    attrs: &[crate::pass1::attrs::RouteAttrs],
    pool: &StringPool,
) -> Result<()> {
    check_alignment(keys.len(), attrs.len(), "write_routes_soa")?;
    let m = keys.len();
    if dest.len() < m * ROUTES_SOA_BYTES_PER_ROUTE {
        return Err(Error::Config(format!(
            "write_routes_soa: region too small need={} have={}",
            m * ROUTES_SOA_BYTES_PER_ROUTE,
            dest.len()
        )));
    }
    // Column base offsets (tight): id@0, agency@4M, short@8M, long@12M,
    // color@16M, text@20M, route_type@24M.
    let (id_base, agency_base, short_base, long_base, color_base, text_base, type_base) =
        (0, 4 * m, 8 * m, 12 * m, 16 * m, 20 * m, 24 * m);
    for (i, key) in keys.iter().enumerate() {
        put_u32(dest, id_base + i * 4, pool.index_of(key));
        put_u32(
            dest,
            agency_base + i * 4,
            pool.index_of(&attrs[i].agency_id),
        );
        put_u32(
            dest,
            short_base + i * 4,
            pool.index_of(&attrs[i].short_name),
        );
        put_u32(dest, long_base + i * 4, pool.index_of(&attrs[i].long_name));
        put_u32(
            dest,
            color_base + i * 4,
            pool.index_of(&attrs[i].route_color),
        );
        put_u32(
            dest,
            text_base + i * 4,
            pool.index_of(&attrs[i].route_text_color),
        );
        dest[type_base + i * 2..type_base + i * 2 + 2]
            .copy_from_slice(&attrs[i].route_type.to_le_bytes());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pass1::{StopAttrs, TripAttrs};
    use crate::strpool::StringPool;

    #[test]
    fn writes_trip_records_with_direction_id_and_shape_id_idx() {
        // 24 B = idIdx@0 | headsignIdx@4 | routeIdx@8 | serviceIdx@12 |
        //            wheelchair@16 | direction_id@17 | bikes_allowed u8@18 | reserved[19] | shapeIdIdx u32@20
        let keys = vec!["T1".to_string()];
        let attrs = vec![TripAttrs {
            route_idx: 3,
            service_idx: 7,
            headsign: "Downtown".into(),
            wheelchair_accessible: 1,
            direction_id: 1,
            bikes_allowed: 2,
            shape_id: "shp_A".into(),
            block_id: String::new(), // build-time only; not written to PTB
            feed_rank: 0,
        }];
        let mut pool = StringPool::new();
        pool.intern(&keys[0]);
        pool.intern(&attrs[0].headsign);
        pool.intern(&attrs[0].shape_id);
        let mut dest = vec![0u8; TRIP_RECORD_BYTES];
        write_trips_intern(&mut dest, &keys, &attrs, &pool).unwrap();
        assert_eq!(
            u32::from_le_bytes(dest[0..4].try_into().unwrap()),
            pool.index_of("T1")
        );
        assert_eq!(
            u32::from_le_bytes(dest[4..8].try_into().unwrap()),
            pool.index_of("Downtown")
        );
        assert_eq!(u32::from_le_bytes(dest[8..12].try_into().unwrap()), 3u32);
        assert_eq!(u32::from_le_bytes(dest[12..16].try_into().unwrap()), 7u32);
        assert_eq!(dest[16], 1); // wheelchair_accessible
        assert_eq!(dest[17], 1); // direction_id
        assert_eq!(&dest[18..20], &[2u8, 0u8]); // bikes_allowed@18, reserved@19
        assert_eq!(
            u32::from_le_bytes(dest[20..24].try_into().unwrap()),
            pool.index_of("shp_A")
        );
    }

    /// The real-feed SoA emit (`write_stops_soa`) quantizes coords from
    /// `StopAttrs.lat/lon` **f64** to `i32@1e7` — NOT through `as f32`. The
    /// f32-divergence witness 54.69 proves it: f64→546900000 but f32→546899986.
    /// Also checks per-axis values (a lat/lon transposition is glaring at distinct
    /// magnitudes), the column-major layout, the dense `u32::MAX` no-parent
    /// sentinel, and a real parent index.
    #[test]
    fn write_stops_soa_quantizes_from_f64_not_f32() {
        // S0: f32-divergence witness 54.69 lat + a near-180 lon, no parent.
        // S1: a 7-decimal survivor lat + negative western lon, parent = S0.
        let keys = vec!["S0".to_string(), "S1".to_string()];
        let attrs = vec![
            StopAttrs {
                name: "Stop Zero".into(),
                lat: 54.69,
                lon: 179.9999823,
                wheelchair_boarding: 2,
                parent_station: String::new(),
            },
            StopAttrs {
                name: "Stop One".into(),
                lat: 54.6912345,
                lon: -73.9856421,
                wheelchair_boarding: 0,
                parent_station: "S0".into(),
            },
        ];
        let parent_idx = vec![u32::MAX, 0]; // S0 no parent; S1 -> S0
        let mut pool = StringPool::new();
        for k in &keys {
            pool.intern(k);
        }
        for a in &attrs {
            pool.intern(&a.name);
        }
        let n = keys.len();
        let mut dest = vec![0u8; n * STOPS_SOA_BYTES_PER_STOP];
        write_stops_soa(&mut dest, &keys, &attrs, &parent_idx, &pool).unwrap();

        // Column bases for N=2.
        let (id_b, name_b, lat_b, lon_b, par_b, wh_b) = (0, 8, 16, 24, 32, 40);
        let rd_u32 = |o: usize| u32::from_le_bytes(dest[o..o + 4].try_into().unwrap());
        let rd_i32 = |o: usize| i32::from_le_bytes(dest[o..o + 4].try_into().unwrap());

        assert_eq!(rd_u32(id_b), pool.index_of("S0"));
        assert_eq!(rd_u32(id_b + 4), pool.index_of("S1"));
        assert_eq!(rd_u32(name_b), pool.index_of("Stop Zero"));
        assert_eq!(rd_u32(name_b + 4), pool.index_of("Stop One"));

        // f64 quantization (THE point of the SoA path): 54.69 -> 546900000, NOT the
        // f32-narrowed 546899986 would produce.
        assert_eq!(rd_i32(lat_b), 546900000, "S0 lat f64-quantized");
        assert_ne!(
            rd_i32(lat_b),
            546899986,
            "S0 lat must NOT be the f32-narrowed value"
        );
        assert_eq!(rd_i32(lat_b + 4), 546912345, "S1 lat 7-decimal survivor");
        // Per-axis lon (distinct magnitude from lat -> catches a transposition).
        assert_eq!(rd_i32(lon_b), 1799999823, "S0 lon near +180");
        assert_eq!(rd_i32(lon_b + 4), -739856421, "S1 negative western lon");

        // Dense parent column: u32::MAX sentinel + real parent.
        assert_eq!(rd_u32(par_b), u32::MAX, "S0 no parent");
        assert_eq!(rd_u32(par_b + 4), 0, "S1 -> S0");
        // wheelchair u8 column LAST.
        assert_eq!(dest[wh_b], 2);
        assert_eq!(dest[wh_b + 1], 0);
    }


    #[test]
    fn write_stops_soa_rejects_out_of_range_lat() {
        let keys = vec!["S0".to_string()];
        let attrs = vec![StopAttrs {
            name: "Bad".into(),
            lat: 90.0000001, // just outside +90
            lon: 25.0,
            wheelchair_boarding: 0,
            parent_station: String::new(),
        }];
        let mut pool = StringPool::new();
        pool.intern(&keys[0]);
        pool.intern(&attrs[0].name);
        let mut dest = vec![0u8; STOPS_SOA_BYTES_PER_STOP];
        let err = write_stops_soa(&mut dest, &keys, &attrs, &[u32::MAX], &pool).unwrap_err();
        assert!(
            format!("{err:?}").contains("lat out of WGS84 range"),
            "got: {err:?}"
        );
    }

    /// Mirror of `write_stops_soa_rejects_out_of_range_lat` on the LON axis: an
    /// in-range lat with an out-of-WGS84 lon must REJECT through the emit path
    /// (the lat-reject test alone left the lon `ok_or_else` arm unexercised
    /// end-to-end).
    #[test]
    fn write_stops_soa_rejects_out_of_range_lon() {
        let keys = vec!["S0".to_string()];
        let attrs = vec![StopAttrs {
            name: "Bad".into(),
            lat: 25.0,
            lon: 180.0000001, // just outside +180
            wheelchair_boarding: 0,
            parent_station: String::new(),
        }];
        let mut pool = StringPool::new();
        pool.intern(&keys[0]);
        pool.intern(&attrs[0].name);
        let mut dest = vec![0u8; STOPS_SOA_BYTES_PER_STOP];
        let err = write_stops_soa(&mut dest, &keys, &attrs, &[u32::MAX], &pool).unwrap_err();
        assert!(
            format!("{err:?}").contains("lon out of WGS84 range"),
            "got: {err:?}"
        );
    }

    /// The WGS84 bound is INCLUSIVE on BOTH axes: exactly ±90 lat / ±180 lon
    /// quantize to the e7 extremes, and anything strictly beyond REJECTS
    /// (`None`). Pins the `coord_quant` boundary semantics the emit path relies
    /// on (`encode_e7_bounded` uses `< -max || > max`).
    #[test]
    fn coord_quant_boundary_inclusive_both_axes() {
        use crate::coord_quant::{encode_lat_e7, encode_lon_e7};
        // Exact at the boundary → accepted (inclusive).
        assert_eq!(encode_lat_e7(90.0), Some(900_000_000));
        assert_eq!(encode_lat_e7(-90.0), Some(-900_000_000));
        assert_eq!(encode_lon_e7(180.0), Some(1_800_000_000));
        assert_eq!(encode_lon_e7(-180.0), Some(-1_800_000_000));
        // Strictly beyond the boundary → rejected on BOTH axes, BOTH signs.
        assert_eq!(encode_lat_e7(90.0001), None);
        assert_eq!(encode_lat_e7(-90.0001), None);
        assert_eq!(encode_lon_e7(180.0001), None);
        assert_eq!(encode_lon_e7(-180.0001), None);
    }
}
