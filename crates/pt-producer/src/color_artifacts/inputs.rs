//! Staged-PTB → color-artifacts-build inputs. Reads routes and stops via the
//! same pt_core::Reader accessors schedule_tiles/inputs.rs uses (confirmed
//! against crates/pt-core/src/reader.rs: num_stops, stop_id, stop_name,
//! stop_lat_f64, stop_lon_f64, num_routes, route_id, route_short_name,
//! route_type, route_color).

use pt_core::Reader;

use crate::error::{Error, Result};
use crate::schedule_tiles::mode::route_type_to_mode;

pub struct ColorArtifactRoute {
    pub id: String,
    pub short_name: String,
    /// GTFS route_color hex WITHOUT '#', "" when absent — same PTB convention
    /// TileRoute::route_color documents.
    pub color: String,
    pub mode: &'static str,
}

pub struct ColorArtifactStop {
    pub id: String,
    pub name: String,
    /// f64 degrees via Reader::stop_lat_f64 — NOT the lossy f32 convenience
    /// accessor. See schedule_tiles/inputs.rs TileStop::lat for why this
    /// matters for current SoA bundles.
    pub lat: f64,
    pub lon: f64,
}

pub struct ColorArtifactInputs {
    /// PTB Routes-region order (irrelevant to output order — clustering
    /// groups by mode and re-sorts by routeCount — but read in a stable
    /// order regardless).
    pub routes: Vec<ColorArtifactRoute>,
    /// PTB Stops-region order — the label-anchor solver's tie-break basis.
    pub stops: Vec<ColorArtifactStop>,
}

/// Reads routes and stops out of an already-parsed `pt_core::Reader`.
///
/// Two notes on deviations from a naive port of the accessor calls:
///
/// - Generic bound: `pt_core::Reader<B>` is generic over its backing byte
///   store (`B = Vec<u8>` in tests, an `Arc<Mmap>`-newtype in pt-serve) and
///   has a single inherent `impl<B: AsRef<[u8]> + Send + Sync + 'static>`
///   block (verified in crates/pt-core/src/reader.rs) — there is no bare
///   `Reader` type to take a reference to. This mirrors the generic-parameter
///   pattern `pt_core::stop_time_cursor::StopTimeCursor::new` already uses
///   for the same reason.
/// - Error conversion: the `Reader` accessors return `pt_core::Result<T>`
///   (i.e. `Result<T, PtbError>`), and `crate::error::Error` has no
///   `From<PtbError>` impl (only `Io`, `Csv`, and the catch-all `Config`
///   variant constructed by hand) — a bare `?` does not compile. Each call is
///   wrapped in `.map_err(...)` into `Error::Config`, the same pattern
///   `schedule_tiles/inputs.rs::load_tile_inputs` uses for every `Reader`
///   call.
pub fn read_inputs<B>(reader: &Reader<B>) -> Result<ColorArtifactInputs>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut routes = Vec::with_capacity(reader.num_routes());
    for i in 0..reader.num_routes() {
        let route_type = reader
            .route_type(i)
            .map_err(|e| Error::Config(format!("route {i} type: {e}")))?;
        routes.push(ColorArtifactRoute {
            id: reader
                .route_id(i)
                .map_err(|e| Error::Config(format!("route {i} id: {e}")))?
                .to_string(),
            short_name: reader
                .route_short_name(i)
                .map_err(|e| Error::Config(format!("route {i} short_name: {e}")))?
                .to_string(),
            color: reader
                .route_color(i)
                .map_err(|e| Error::Config(format!("route {i} color: {e}")))?
                .to_string(),
            mode: route_type_to_mode(route_type),
        });
    }

    let mut stops = Vec::with_capacity(reader.num_stops());
    for i in 0..reader.num_stops() {
        stops.push(ColorArtifactStop {
            id: reader
                .stop_id(i)
                .map_err(|e| Error::Config(format!("stop {i} id: {e}")))?
                .to_string(),
            name: reader
                .stop_name(i)
                .map_err(|e| Error::Config(format!("stop {i} name: {e}")))?
                .to_string(),
            lat: reader
                .stop_lat_f64(i)
                .map_err(|e| Error::Config(format!("stop {i} lat: {e}")))?,
            lon: reader
                .stop_lon_f64(i)
                .map_err(|e| Error::Config(format!("stop {i} lon: {e}")))?,
        });
    }

    Ok(ColorArtifactInputs { routes, stops })
}

#[cfg(test)]
mod tests {
    use super::read_inputs;

    // Smoke-load a real committed differential fixture through `read_inputs`,
    // mirroring the smoke tests in schedule_tiles/inputs.rs. This only proves
    // the Reader accessor wiring is correct end-to-end (counts line up,
    // no per-row error) — clustering/palette/anchor logic lands in later
    // tasks.
    fn smoke_load(fixture: &str) {
        let fixture_path = format!(
            "{}/../../packages/frontend/tests/services/__fixtures__/{fixture}",
            env!("CARGO_MANIFEST_DIR")
        );
        let bytes =
            std::fs::read(&fixture_path).unwrap_or_else(|e| panic!("{fixture} fixture reads: {e}"));
        let reader =
            pt_core::Reader::from_bytes(bytes).unwrap_or_else(|e| panic!("{fixture} parses: {e}"));

        let inputs = read_inputs(&reader).unwrap_or_else(|e| panic!("{fixture} read_inputs: {e}"));

        assert_eq!(inputs.routes.len(), reader.num_routes());
        assert_eq!(inputs.stops.len(), reader.num_stops());
    }

    #[test]
    fn loads_three_leg_fixture() {
        // Compact committed fixture.
        smoke_load("three-leg.ptb");
    }

    #[test]
    fn loads_current_soa_fixture_with_exact_f64_coords() {
        // example-city.ptb is a PTB v1 SoA-sourced bundle built by the real producer
        // (packages/frontend/scripts/regen-example-city-ptb.sh) — the path where
        // the convenience Reader::stop() record is lossy f32 and the *_f64
        // accessors are required.
        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/frontend/tests/services/__fixtures__/example-city.ptb"
        );
        let bytes = std::fs::read(fixture_path).expect("example-city.ptb fixture reads");
        let reader = pt_core::Reader::from_bytes(bytes).expect("example-city.ptb parses");
        assert_eq!(
            reader.header().version,
            pt_core::PTB_VERSION_V1,
            "example-city.ptb is not current — regenerate it with \
             packages/frontend/scripts/regen-example-city-ptb.sh"
        );

        let inputs = read_inputs(&reader).expect("read_inputs succeeds");
        for (i, stop) in inputs.stops.iter().enumerate() {
            assert_eq!(stop.lat, reader.stop_lat_f64(i).unwrap(), "stop {i} lat");
            assert_eq!(stop.lon, reader.stop_lon_f64(i).unwrap(), "stop {i} lon");
        }
    }

    #[test]
    fn route_mode_and_color_are_read_verbatim() {
        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/frontend/tests/services/__fixtures__/three-leg.ptb"
        );
        let bytes = std::fs::read(fixture_path).expect("three-leg.ptb fixture reads");
        let reader = pt_core::Reader::from_bytes(bytes).expect("three-leg.ptb parses");
        let inputs = read_inputs(&reader).expect("read_inputs succeeds");

        for (i, route) in inputs.routes.iter().enumerate() {
            // mode is a pure function of route_type — cross-check directly
            // rather than hardcoding fixture-specific expectations.
            let route_type = reader.route_type(i).unwrap();
            assert_eq!(
                route.mode,
                crate::schedule_tiles::mode::route_type_to_mode(route_type)
            );
        }
    }
}
