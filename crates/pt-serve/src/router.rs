/// Which listener received the request. The same [`resolve`] function serves
/// every listener, but the route table it exposes differs by listener so the
/// loopback listener (bound on an open `0.0.0.0:9002` with NO host-port
/// mapping) cannot serve `/plan`, `/raptor-bundle`, the scrape surface, etc. —
/// only the single loopback-internal route.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListenerKind {
    /// The main (`:9000`) listener. nginx proxies external application
    /// traffic here; it serves the public Contract-A surface.
    Public,
    /// The auxiliary (`:9001`) listener. It has one isolated worker and serves
    /// only lightweight lifecycle/observability routes.
    Auxiliary,
    /// The loopback (`:9002`) listener. Reachable only from inside the
    /// container (no compose host-port mapping + an nginx isolation CI gate).
    /// Serves ONLY `GET /api/<city>/scheduled-departures-for-stop`.
    Loopback,
}

/// Resolved route after matching method + path against the mmaped city.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Plan,                  // POST /api/<city>/plan
    RaptorBundle,          // GET  /api/<city>/raptor-bundle
    TransfersFetch,        // GET  /api/<city>/transfers/fetch
    RouteGeometryFetch,    // GET  /api/<city>/route-geometry/fetch
    AddressSearch,         // GET  /api/<city>/address-search
    AddressSearchManifest, // GET  /api/<city>/address-search/manifest
    AddressSearchBundle,   // GET  /api/<city>/address-search/bundle
    /// GET /api/<city>/scheduled-departures-for-stop — served ONLY on the
    /// loopback listener. On the public listeners this path resolves to
    /// `NotFound` (404) so the route never escapes the container.
    ScheduledDeparturesForStop,
    /// GET /api/<city>/departures-for-stop — the PUBLIC departures API
    /// (schedule + live RT overlay). Distinct from the loopback-only
    /// `ScheduledDeparturesForStop` above, which keeps its frozen
    /// contractVersion 1 and stays off the public listeners.
    DeparturesForStop,
    Health, // GET /health
    /// GET /health/rt — GTFS-RT poller health (Node parity:
    /// `/api/health/rt` in `packages/backend/src/routes/rtHealth.ts`).
    RtHealth,
    Ready,   // GET /ready
    Version, // GET /version
    Metrics, // GET /metrics
    /// Test-only park handler — feature `test-park`. The dispatcher blocks
    /// the worker until the timeout watchdog flips its `timed_out` flag.
    /// Compiled out in production; the route resolves to `NotFound` when
    /// the feature is off.
    #[cfg(feature = "test-park")]
    TestPark, // GET /test/park
    /// POST /api/<city>/client-report — opt-in client engine-failure report.
    /// Node parity: `packages/backend/src/routes/clientReport.ts`, mounted
    /// internally at `/api/client-report`. Like the tile routes, the real
    /// client contract carries the city segment and pt-serve matches it
    /// directly, so its nginx location must NOT rewrite.
    ///
    /// The only POST here besides `Plan`, which is why the dispatcher's
    /// body-reading branch had to stop being a `matches!(route, Route::Plan)`.
    ClientReport,
    /// GET /api/<city>/rt/<routeId> — live RT for one route, as the
    /// `RouteUpdate` protobuf. Node parity:
    /// `packages/backend/src/routes/rt.ts`. Polled by the client's rtPoller
    /// during navigation.
    RouteRt(String),
    ColorConfig,    // GET /api/<city>/color-config
    StopsAll,       // GET /api/<city>/stops/all
    StopsNearby,    // GET /api/<city>/stops/nearby
    Shapes(String), // GET /api/<city>/gtfs/shapes/<artifact>
    /// GET /api/<city>/gtfs/manifest. Node parity:
    /// `packages/backend/src/routes/gtfsManifest.ts`, same internal-vs-client
    /// URL divergence as `ScheduleTile` below (nginx strips the city segment
    /// before proxying to Node; the real client contract carries it, see
    /// `packages/frontend/src/services/api.ts` `fetchManifest`).
    GtfsManifest,
    /// GET /api/<city>/alerts — the city's GTFS-RT service alerts. City-wide
    /// on purpose: no stop or route parameters, so the request discloses
    /// only the city. Public listeners only.
    ServiceAlerts,
    /// GET /api/<city>/gtfs/schedule-tile/<bundleHash>/<tileSize>/<tileCoords>.
    /// Node parity: `packages/backend/src/routes/scheduleTile.ts`, mounted
    /// internally at `/api/gtfs/schedule-tile/...` (nginx strips the city
    /// segment per-city before proxying) — the real client contract carries
    /// the city segment (`packages/frontend/src/stores/cityStore.ts:67`),
    /// matching every other route in this table.
    ScheduleTile(String, String, String),
    /// GET /api/<city>/gtfs/rt-tile/<bundleHash>/<tileSize>/<tileCoords>.
    /// Node parity: `packages/backend/src/routes/rtTile.ts`, same
    /// internal-vs-client URL divergence as `ScheduleTile` above (nginx
    /// strips the city segment; the real client contract carries it).
    RtTile(String, String, String),
    /// GET/HEAD /api/gtfs/poi-tile/<cityId>/<tileSize>/<tileCoords>. Node
    /// parity: `packages/backend/src/routes/poiTile.ts`. UNLIKE every other
    /// route in this table: NO outer `/api/<city>/` segment and NO
    /// `--city-slug` gate at all. POI tiles are multi-city and independent
    /// of whatever GTFS feed this pt-serve process runs. The
    /// frontend's real client call
    /// (`packages/frontend/src/services/tileLoader.ts:92`) confirms this
    /// URL shape has no city-slug prefix, and `nginx/city-proxies.inc` has
    /// no per-city routing for this route either. `cityId` here is the
    /// route's OWN path segment, resolved against the published POI manifest
    /// by the handler, not matched against `ServerConfig::city_slug`.
    PoiTile(String, String, String),
    /// CORS preflight for the city-agnostic POI route family.
    PoiTileOptions,
    /// Fastify rejects malformed percent encodings before route hooks run.
    PoiTileBadUrl(String),
    /// Fastify's router rejects a GET/HEAD capture over `maxParamLength`
    /// before route hooks run. Carries the path as find-my-way reports it:
    /// query stripped, `decodeURI`-decoded.
    PoiTileParamTooLong(String),
    /// Fastify route-level 404.
    PoiTileNotFound {
        method: String,
        url: String,
    },
    NotFound,
    WrongCity, // path was /api/<other>/... -> 404
    MethodNotAllowed,
}

// Fastify/find-my-way's default maxParamLength is 100 JavaScript string
// (`UTF-16`) code units. A three-byte BMP scalar can take nine percent-encoded
// ASCII bytes per code unit, so 900 is the largest valid encoded spelling.
// The POI handler separately keeps cityId at 64 UTF-8 bytes.
const MAX_POI_PATH_COMPONENT_UTF16_UNITS: usize = 100;
const MAX_ENCODED_POI_PATH_COMPONENT_BYTES: usize = 900;

#[derive(Debug, PartialEq, Eq)]
enum PoiPathDecodeError {
    Malformed,
    TooLong,
}

fn percent_encoding_is_well_formed(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        let Some(encoded) = bytes.get(index + 1..index + 3) else {
            return false;
        };
        if !encoded.iter().all(u8::is_ascii_hexdigit) {
            return false;
        }
        index += 3;
    }
    true
}

fn percent_decodes_as_utf8(raw: &str) -> bool {
    percent_encoding_is_well_formed(raw)
        && percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .is_ok()
}

/// The path find-my-way hands to its `onMaxParamLength` handler: `decodeURI`
/// semantics, so escapes of the reserved set `#$&+,/:;=?@` stay encoded as
/// written, and `%25` stays `%25` rather than decoding to `%`. The caller has
/// already proven the path percent-decodes to UTF-8.
fn fastify_decoded_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let Some(byte) = bytes
                .get(index + 1..index + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                if b"#$&+,/:;=?@%".contains(&byte) {
                    decoded.extend_from_slice(&bytes[index..index + 3]);
                } else {
                    decoded.push(byte);
                }
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn decode_poi_path_component(raw: &str) -> Result<String, PoiPathDecodeError> {
    if !percent_encoding_is_well_formed(raw) {
        return Err(PoiPathDecodeError::Malformed);
    }
    if raw.len() > MAX_ENCODED_POI_PATH_COMPONENT_BYTES {
        return Err(PoiPathDecodeError::TooLong);
    }

    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| PoiPathDecodeError::Malformed)?;
    if decoded.encode_utf16().count() > MAX_POI_PATH_COMPONENT_UTF16_UNITS {
        return Err(PoiPathDecodeError::TooLong);
    }
    Ok(decoded.into_owned())
}

/// Resolve a request to a [`Route`]. The `listener` arg partitions the route
/// table:
///
/// - On [`ListenerKind::Auxiliary`] only lifecycle/observability GETs are
///   exposed; application routes are `NotFound`.
/// - On [`ListenerKind::Loopback`] the ONLY served route is
///   `GET /api/<city>/scheduled-departures-for-stop`; a city-slug mismatch is
///   `WrongCity`, and EVERYTHING else (incl. `/plan`, `/raptor-bundle`,
///   `/transfers/fetch`, `/health`, `/metrics`, …) is `NotFound`. This is the
///   isolation contract: the open `0.0.0.0:9002` listener exposes one route.
/// - On [`ListenerKind::Public`] the behaviour is the historical P3/P4 route
///   table, with the single addition that
///   `GET /api/<city>/scheduled-departures-for-stop` resolves to `NotFound`
///   (404 on the public listeners).
pub fn resolve(method: &str, path: &str, city: &str, listener: ListenerKind) -> Route {
    let request_url = path;
    // strip query string
    let path = path.split('?').next().unwrap_or(path);

    if listener == ListenerKind::Auxiliary {
        return match (method, path) {
            ("GET", "/health") => Route::Health,
            ("GET", "/health/rt") => Route::RtHealth,
            ("GET", "/ready") => Route::Ready,
            ("GET", "/version") => Route::Version,
            ("GET", "/metrics") => Route::Metrics,
            _ => Route::NotFound,
        };
    }

    if listener == ListenerKind::Loopback {
        // Loopback listener: serve ONLY the city-scoped scheduled-departures
        // route. The slug gate still applies (WrongCity on mismatch); every
        // other path/method is NotFound so the open port leaks nothing else.
        //
        // The city-agnostic poi-tile path carries NO city segment at all
        // (`/api/gtfs/poi-tile/...` — `gtfs` is a fixed prefix, not a
        // variable slug), so it must be rejected here BEFORE the generic
        // seg/tail split below, which would otherwise misread `gtfs` as a
        // candidate city segment and return `WrongCity` instead of
        // `NotFound` — violating this branch's own "everything else is
        // NotFound" contract (functionally identical over HTTP, since the
        // dispatcher maps both to the same 404, but the Route value itself
        // should stay honest).
        if path.starts_with("/api/gtfs/poi-tile/") {
            return Route::NotFound;
        }
        let rest = match path.strip_prefix("/api/") {
            Some(r) => r,
            None => return Route::NotFound,
        };
        let mut parts = rest.splitn(2, '/');
        let seg = parts.next().unwrap_or("");
        let tail = parts.next().unwrap_or("");
        if seg != city {
            return Route::WrongCity;
        }
        return match (method, tail) {
            ("GET", "scheduled-departures-for-stop") => Route::ScheduledDeparturesForStop,
            _ => Route::NotFound,
        };
    }

    // Public listeners (main + aux): the historical route table.
    match (method, path) {
        ("GET", "/health") => Route::Health,
        ("GET", "/health/rt") => Route::RtHealth,
        ("GET", "/ready") => Route::Ready,
        ("GET", "/version") => Route::Version,
        ("GET", "/metrics") => Route::Metrics,
        #[cfg(feature = "test-park")]
        ("GET", "/test/park") => Route::TestPark,
        // City-agnostic: matched on PATH ALONE (any method), BEFORE the
        // /api/<city>/... branch below, so it never gets city-slug-gated
        // against a `seg` of "gtfs" (see the `Route::PoiTile` doc for why
        // this route carries no city segment). Gating this arm on `path`
        // only — not `("GET", p)` — matters: a non-GET request must still
        // land here and resolve to NotFound, not fall through to the
        // generic branch and misresolve as WrongCity.
        (_, p) if p.starts_with("/api/gtfs/poi-tile/") => {
            let rest = &p["/api/gtfs/poi-tile/".len()..];
            // Fastify parses the URL before @fastify/cors handles its wildcard
            // OPTIONS route. Malformed percent escapes or decoded UTF-8 must
            // therefore take FST_ERR_BAD_URL even for preflight requests.
            if !percent_decodes_as_utf8(rest) {
                return Route::PoiTileBadUrl(request_url.to_string());
            }
            if method == "OPTIONS" {
                return Route::PoiTileOptions;
            }
            // find-my-way checks each capture's length as it walks the POI
            // route, so an over-long one among the first three rejects the
            // request before the segment count is known. Only GET/HEAD have
            // the route to walk; other methods stay a plain 404 below.
            if matches!(method, "GET" | "HEAD")
                && rest.split('/').take(3).any(|segment| {
                    matches!(
                        decode_poi_path_component(segment),
                        Err(PoiPathDecodeError::TooLong)
                    )
                })
            {
                return Route::PoiTileParamTooLong(fastify_decoded_path(path));
            }
            // Exactly 3 non-empty segments, same grammar-light gate as
            // ScheduleTile/RtTile — the handler owns cityId/tileSize/
            // tileCoords validation.
            let mut segments = rest.split('/');
            let (Some(city_id), Some(tile_size), Some(tile_coords), None) = (
                segments.next(),
                segments.next(),
                segments.next(),
                segments.next(),
            ) else {
                return Route::PoiTileNotFound {
                    method: method.to_string(),
                    url: request_url.to_string(),
                };
            };
            if city_id.is_empty() || tile_size.is_empty() || tile_coords.is_empty() {
                return Route::PoiTileNotFound {
                    method: method.to_string(),
                    url: request_url.to_string(),
                };
            }

            let decoded = (
                decode_poi_path_component(city_id),
                decode_poi_path_component(tile_size),
                decode_poi_path_component(tile_coords),
            );
            match decoded {
                (Ok(city_id), Ok(tile_size), Ok(tile_coords))
                    if matches!(method, "GET" | "HEAD") =>
                {
                    Route::PoiTile(city_id, tile_size, tile_coords)
                }
                (Err(PoiPathDecodeError::Malformed), _, _)
                | (_, Err(PoiPathDecodeError::Malformed), _)
                | (_, _, Err(PoiPathDecodeError::Malformed)) => {
                    Route::PoiTileBadUrl(request_url.to_string())
                }
                _ => Route::PoiTileNotFound {
                    method: method.to_string(),
                    url: request_url.to_string(),
                },
            }
        }
        _ => {
            // /api/<seg>/<rest>
            let rest = match path.strip_prefix("/api/") {
                Some(r) => r,
                None => return Route::NotFound,
            };
            let mut parts = rest.splitn(2, '/');
            let seg = parts.next().unwrap_or("");
            let tail = parts.next().unwrap_or("");
            if seg != city {
                return Route::WrongCity;
            }
            match (method, tail) {
                ("POST", "plan") => Route::Plan,
                ("POST", "client-report") => Route::ClientReport,
                ("GET", "raptor-bundle") => Route::RaptorBundle,
                ("GET", "transfers/fetch") => Route::TransfersFetch,
                ("GET", "route-geometry/fetch") => Route::RouteGeometryFetch,
                ("GET", "address-search") => Route::AddressSearch,
                ("GET", "address-search/manifest") => Route::AddressSearchManifest,
                ("GET", "address-search/bundle") => Route::AddressSearchBundle,
                // The scheduled-departures route is loopback-only — 404 on the
                // public listeners so it never escapes the container. The
                // PUBLIC departures API is `departures-for-stop` below; the two
                // are deliberately different paths.
                ("GET", "scheduled-departures-for-stop") => Route::NotFound,
                ("GET", "departures-for-stop") => Route::DeparturesForStop,
                ("GET", t) if t.starts_with("rt/") => {
                    let route_id = &t["rt/".len()..];
                    // Exactly one non-empty segment. The handler applies Node's
                    // character/length guard and answers 400; an embedded slash
                    // is a shape error, so it is 404 here instead.
                    if route_id.is_empty() || route_id.contains('/') {
                        Route::NotFound
                    } else {
                        Route::RouteRt(route_id.to_string())
                    }
                }
                ("GET", "color-config") => Route::ColorConfig,
                ("GET", "stops/all") => Route::StopsAll,
                ("GET", "stops/nearby") => Route::StopsNearby,
                ("GET", "gtfs/manifest") => Route::GtfsManifest,
                ("GET", "alerts") => Route::ServiceAlerts,
                ("GET", t) if t.starts_with("gtfs/shapes/") => {
                    let artifact = &t["gtfs/shapes/".len()..];
                    // single non-empty segment, length-capped (a sha256-hex
                    // artifact `shapes-<64hex>.json` is 76 chars).
                    if artifact.is_empty() || artifact.contains('/') || artifact.len() > 80 {
                        Route::NotFound
                    } else {
                        Route::Shapes(artifact.to_string())
                    }
                }
                ("GET", t) if t.starts_with("gtfs/schedule-tile/") => {
                    let rest = &t["gtfs/schedule-tile/".len()..];
                    // Exactly 3 non-empty segments — `split` (not `splitn`)
                    // so a 4th segment (or a trailing slash) is rejected
                    // rather than swallowed into the 3rd capture.
                    match rest.split('/').collect::<Vec<&str>>().as_slice() {
                        [h, s, c] if !h.is_empty() && !s.is_empty() && !c.is_empty() => {
                            Route::ScheduleTile(h.to_string(), s.to_string(), c.to_string())
                        }
                        _ => Route::NotFound,
                    }
                }
                ("GET", t) if t.starts_with("gtfs/rt-tile/") => {
                    let rest = &t["gtfs/rt-tile/".len()..];
                    match rest.split('/').collect::<Vec<&str>>().as_slice() {
                        [h, s, c] if !h.is_empty() && !s.is_empty() && !c.is_empty() => {
                            Route::RtTile(h.to_string(), s.to_string(), c.to_string())
                        }
                        _ => Route::NotFound,
                    }
                }
                ("GET", _) | ("POST", _) => Route::NotFound,
                _ => Route::MethodNotAllowed,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_city_scoped_routes() {
        assert_eq!(
            resolve("POST", "/api/vilnius/plan", "vilnius", ListenerKind::Public),
            Route::Plan
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/raptor-bundle",
                "vilnius",
                ListenerKind::Public
            ),
            Route::RaptorBundle
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/transfers/fetch",
                "vilnius",
                ListenerKind::Public
            ),
            Route::TransfersFetch
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/route-geometry/fetch",
                "vilnius",
                ListenerKind::Public
            ),
            Route::RouteGeometryFetch
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/address-search?q=Kudirkos",
                "vilnius",
                ListenerKind::Public
            ),
            Route::AddressSearch
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/address-search/manifest",
                "vilnius",
                ListenerKind::Public
            ),
            Route::AddressSearchManifest
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/address-search/bundle",
                "vilnius",
                ListenerKind::Public
            ),
            Route::AddressSearchBundle
        );
        // GET on plan -> NotFound (only POST is valid)
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/plan?x=1",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn wrong_city_is_404() {
        assert_eq!(
            resolve("POST", "/api/krakow/plan", "vilnius", ListenerKind::Public),
            Route::WrongCity
        );
    }

    #[test]
    fn liveness_paths() {
        assert_eq!(
            resolve("GET", "/health", "vilnius", ListenerKind::Public),
            Route::Health
        );
        assert_eq!(
            resolve("GET", "/ready", "vilnius", ListenerKind::Public),
            Route::Ready
        );
    }

    #[test]
    fn query_string_stripped() {
        assert_eq!(
            resolve("GET", "/health?foo=bar", "vilnius", ListenerKind::Public),
            Route::Health
        );
        assert_eq!(
            resolve("GET", "/ready?x=1", "vilnius", ListenerKind::Public),
            Route::Ready
        );
    }

    #[test]
    fn rt_health_resolves_on_public_listeners_only() {
        assert_eq!(
            resolve("GET", "/health/rt", "vilnius", ListenerKind::Public),
            Route::RtHealth
        );
        // Query strings are stripped the same way /health's are.
        assert_eq!(
            resolve(
                "GET",
                "/health/rt?verbose=1",
                "vilnius",
                ListenerKind::Public
            ),
            Route::RtHealth
        );
        // Loopback isolation contract: only scheduled-departures exists there.
        assert_eq!(
            resolve("GET", "/health/rt", "vilnius", ListenerKind::Loopback),
            Route::NotFound
        );
        // Non-GET falls through the city-route resolver to NotFound.
        assert_eq!(
            resolve("POST", "/health/rt", "vilnius", ListenerKind::Public),
            Route::NotFound
        );
    }

    // ---- ListenerKind isolation (Stage-C C2c) ----

    /// The loopback listener resolves the scheduled-departures route…
    #[test]
    fn loopback_resolves_scheduled_departures() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/scheduled-departures-for-stop",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::ScheduledDeparturesForStop
        );
        // …and the query string is stripped on the loopback path too.
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/scheduled-departures-for-stop?stop=123",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::ScheduledDeparturesForStop
        );
    }

    /// The PUBLIC departures API resolves on the public listeners. This is a
    /// DIFFERENT path from the loopback route above — the two must never be
    /// conflated, which is why both directions are pinned here.
    #[test]
    fn public_resolves_departures_for_stop() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/departures-for-stop",
                "vilnius",
                ListenerKind::Public
            ),
            Route::DeparturesForStop
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/departures-for-stop?stopId=1&from=0",
                "vilnius",
                ListenerKind::Public
            ),
            Route::DeparturesForStop
        );
    }

    /// Adding the public departures route must NOT have opened the loopback
    /// one: `scheduled-departures-for-stop` still 404s on public. The
    /// `nginx-loopback-isolation` CI gate enforces the same property one layer
    /// out; this is the in-process half.
    #[test]
    fn public_departures_route_does_not_expose_the_loopback_one() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/scheduled-departures-for-stop",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    /// …but the SAME route is 404 on the public listeners (never escapes).
    #[test]
    fn public_404s_scheduled_departures() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/scheduled-departures-for-stop",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn route_rt_captures_exactly_one_segment() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/rt/route-7",
                "vilnius",
                ListenerKind::Public
            ),
            Route::RouteRt("route-7".to_string())
        );
        // Shape errors are 404 here; CONTENT errors (bad characters, too long)
        // are the handler's 400, matching Node's split between find-my-way and
        // its own regex guard.
        for bad in ["/api/vilnius/rt/", "/api/vilnius/rt/a/b", "/api/vilnius/rt"] {
            assert_eq!(
                resolve("GET", bad, "vilnius", ListenerKind::Public),
                Route::NotFound,
                "{bad}"
            );
        }
    }

    #[test]
    fn route_rt_does_not_shadow_the_rt_tile_route() {
        // Both live under the city prefix and both start with the letters
        // "rt", but rt-tile's tail begins `gtfs/rt-tile/`. A `starts_with("rt")`
        // guard instead of `starts_with("rt/")` would swallow nothing today yet
        // would break the moment a sibling `rt-...` route is added.
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/rt-tile/abc/6km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::RtTile("abc".to_string(), "6km".to_string(), "1_2".to_string())
        );
    }

    #[test]
    fn route_rt_is_get_only_and_public_only() {
        assert_eq!(
            resolve(
                "POST",
                "/api/vilnius/rt/r1",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        for listener in [ListenerKind::Loopback, ListenerKind::Auxiliary] {
            assert_eq!(
                resolve("GET", "/api/vilnius/rt/r1", "vilnius", listener),
                Route::NotFound,
                "{listener:?}"
            );
        }
        assert_eq!(
            resolve("GET", "/api/krakow/rt/r1", "vilnius", ListenerKind::Public),
            Route::WrongCity
        );
    }

    #[test]
    fn client_report_is_post_only_and_city_scoped() {
        assert_eq!(
            resolve(
                "POST",
                "/api/vilnius/client-report",
                "vilnius",
                ListenerKind::Public
            ),
            Route::ClientReport
        );
        // GET must not resolve: Node registers only the POST, and a GET that
        // silently succeeded would let a crawler mint metric series.
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/client-report",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // Same slug gate as every other city-scoped route.
        assert_eq!(
            resolve(
                "POST",
                "/api/krakow/client-report",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
    }

    #[test]
    fn client_report_is_not_reachable_off_the_public_listeners() {
        // The loopback listener serves exactly one route and the auxiliary
        // listener serves the five ops endpoints; a POST route that leaked onto
        // either would be reachable without passing nginx's rate limit.
        for listener in [ListenerKind::Loopback, ListenerKind::Auxiliary] {
            assert_eq!(
                resolve("POST", "/api/vilnius/client-report", "vilnius", listener),
                Route::NotFound,
                "{listener:?}"
            );
        }
    }

    #[test]
    fn client_report_is_matched_with_the_city_segment_not_nodes_stripped_spelling() {
        // Node registers `/api/client-report` and lets nginx strip the slug.
        // pt-serve matches the client's real URL directly, so its nginx
        // location must not rewrite — if this ever resolved, a rewrite would
        // start "working" and the two spellings would silently diverge.
        assert_eq!(
            resolve(
                "POST",
                "/api/client-report",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
    }

    /// `/plan` works on the public listener but is 404 on loopback.
    #[test]
    fn plan_is_public_only() {
        assert_eq!(
            resolve("POST", "/api/vilnius/plan", "vilnius", ListenerKind::Public),
            Route::Plan
        );
        assert_eq!(
            resolve(
                "POST",
                "/api/vilnius/plan",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
    }

    /// `/raptor-bundle` (and the rest of the public surface) is 404 on loopback.
    #[test]
    fn raptor_bundle_and_scrape_are_404_on_loopback() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/raptor-bundle",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/transfers/fetch",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/route-geometry/fetch",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        // Liveness/scrape paths are NOT served on loopback either.
        assert_eq!(
            resolve("GET", "/health", "vilnius", ListenerKind::Loopback),
            Route::NotFound
        );
        assert_eq!(
            resolve("GET", "/metrics", "vilnius", ListenerKind::Loopback),
            Route::NotFound
        );
    }

    /// City-slug gate still applies on the loopback listener.
    #[test]
    fn loopback_wrong_city_is_404() {
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/scheduled-departures-for-stop",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::WrongCity
        );
    }

    #[test]
    fn matches_color_config_and_shapes() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/color-config",
                "vilnius",
                ListenerKind::Public
            ),
            Route::ColorConfig
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/shapes/shapes-abc123.json",
                "vilnius",
                ListenerKind::Public
            ),
            Route::Shapes("shapes-abc123.json".to_string())
        );
    }

    #[test]
    fn matches_stops_all() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/stops/all",
                "vilnius",
                ListenerKind::Public
            ),
            Route::StopsAll
        );
        // query stripped
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/stops/all?withinHours=2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::StopsAll
        );
        // wrong city is 404
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/stops/all",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
        // loopback never serves it
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/stops/all",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
    }

    #[test]
    fn matches_stops_nearby() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/stops/nearby",
                "vilnius",
                ListenerKind::Public
            ),
            Route::StopsNearby
        );
        // query stripped
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/stops/nearby?lat=54.7&lon=25.3&radius=500",
                "vilnius",
                ListenerKind::Public
            ),
            Route::StopsNearby
        );
        // wrong city is 404
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/stops/nearby",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
        // loopback never serves it
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/stops/nearby",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        // POST is not allowed (only GET) → falls through to NotFound
        assert_eq!(
            resolve(
                "POST",
                "/api/vilnius/stops/nearby",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn shapes_edge_cases_are_not_found() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/shapes/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/shapes/a/b",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        let long = format!("shapes-{}.json", "a".repeat(200));
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/shapes/{long}"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn gtfs_other_routes_fall_through_and_wrong_city() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/raptor-data",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/color-config",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/color-config?x=1",
                "vilnius",
                ListenerKind::Public
            ),
            Route::ColorConfig
        ); // query stripped
    }

    #[test]
    fn matches_gtfs_manifest() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/manifest",
                "vilnius",
                ListenerKind::Public
            ),
            Route::GtfsManifest
        );
        // Query strings are stripped before matching, like every other route.
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/manifest?v=2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::GtfsManifest
        );
    }

    /// Exact match only: the manifest takes no path parameters, so anything
    /// past the segment is a 404 rather than a capture. Guards against the
    /// `gtfs/shapes/`-style prefix arms below it swallowing these.
    #[test]
    fn gtfs_manifest_is_an_exact_segment() {
        for path in [
            "/api/vilnius/gtfs/manifest/",
            "/api/vilnius/gtfs/manifest/extra",
            "/api/vilnius/gtfs/manifes",
            "/api/vilnius/gtfs/manifestx",
        ] {
            assert_eq!(
                resolve("GET", path, "vilnius", ListenerKind::Public),
                Route::NotFound,
                "{path}"
            );
        }
    }

    #[test]
    fn gtfs_manifest_wrong_city_and_loopback() {
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/gtfs/manifest",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
        // Public-only, like every other read route — the loopback listener
        // serves scheduled-departures and nothing else.
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/manifest",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
    }

    #[test]
    fn service_alerts_route_is_public_city_wide_and_get_only() {
        let r = |method, path, listener| resolve(method, path, "vilnius", listener);
        assert_eq!(
            r("GET", "/api/vilnius/alerts", ListenerKind::Public),
            Route::ServiceAlerts
        );
        // The query string is ignored: the route takes no parameters.
        assert_eq!(
            r("GET", "/api/vilnius/alerts?stop=S1", ListenerKind::Public),
            Route::ServiceAlerts
        );
        assert_eq!(
            r("GET", "/api/vilnius/alerts/S1", ListenerKind::Public),
            Route::NotFound
        );
        assert_eq!(
            r("GET", "/api/krakow/alerts", ListenerKind::Public),
            Route::WrongCity
        );
        assert_eq!(
            r("POST", "/api/vilnius/alerts", ListenerKind::Public),
            Route::NotFound
        );
        assert_eq!(
            r("DELETE", "/api/vilnius/alerts", ListenerKind::Public),
            Route::MethodNotAllowed
        );
        for listener in [ListenerKind::Loopback, ListenerKind::Auxiliary] {
            assert_eq!(
                r("GET", "/api/vilnius/alerts", listener),
                Route::NotFound,
                "{listener:?}"
            );
        }
    }

    #[test]
    fn gtfs_manifest_rejects_non_get() {
        assert_eq!(
            resolve(
                "DELETE",
                "/api/vilnius/gtfs/manifest",
                "vilnius",
                ListenerKind::Public
            ),
            Route::MethodNotAllowed
        );
    }

    /// The color-config / shapes routes are public-only — 404 on loopback.
    #[test]
    fn color_config_and_shapes_404_on_loopback() {
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/color-config",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/shapes/shapes-abc123.json",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
    }

    #[test]
    fn matches_schedule_tile() {
        let hash = "a".repeat(64);
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/schedule-tile/{hash}/6km/12_34"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::ScheduleTile(hash.clone(), "6km".to_string(), "12_34".to_string())
        );
        // query stripped
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/schedule-tile/{hash}/6km/12_34?x=1"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::ScheduleTile(hash.clone(), "6km".to_string(), "12_34".to_string())
        );
        // leaf coord (dash-suffixed) passes through unvalidated — the
        // handler owns grammar validation.
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/schedule-tile/{hash}/6km/12_34-0-3"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::ScheduleTile(hash, "6km".to_string(), "12_34-0-3".to_string())
        );
    }

    #[test]
    fn schedule_tile_edge_cases_are_not_found() {
        // too few segments
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/schedule-tile/abc/6km",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // too many segments
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/schedule-tile/abc/6km/12_34/extra",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // trailing slash (empty final segment)
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/schedule-tile/abc/6km/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // empty root
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/schedule-tile/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn schedule_tile_wrong_city_and_loopback() {
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/gtfs/schedule-tile/abc/6km/12_34",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/schedule-tile/abc/6km/12_34",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        // POST not allowed
        assert_eq!(
            resolve(
                "POST",
                "/api/vilnius/gtfs/schedule-tile/abc/6km/12_34",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn matches_rt_tile() {
        let hash = "a".repeat(64);
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/rt-tile/{hash}/6km/12_34"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::RtTile(hash.clone(), "6km".to_string(), "12_34".to_string())
        );
        // query stripped
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/rt-tile/{hash}/6km/12_34?x=1"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::RtTile(hash.clone(), "6km".to_string(), "12_34".to_string())
        );
        // leaf coord (dash-suffixed) passes through unvalidated — the
        // handler owns grammar validation.
        assert_eq!(
            resolve(
                "GET",
                &format!("/api/vilnius/gtfs/rt-tile/{hash}/6km/12_34-0-3"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::RtTile(hash, "6km".to_string(), "12_34-0-3".to_string())
        );
    }

    #[test]
    fn rt_tile_edge_cases_are_not_found() {
        // too few segments
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/rt-tile/abc/6km",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // too many segments
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/rt-tile/abc/6km/12_34/extra",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // trailing slash (empty final segment)
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/rt-tile/abc/6km/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
        // empty root
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/rt-tile/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn rt_tile_wrong_city_and_loopback() {
        assert_eq!(
            resolve(
                "GET",
                "/api/krakow/gtfs/rt-tile/abc/6km/12_34",
                "vilnius",
                ListenerKind::Public
            ),
            Route::WrongCity
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/vilnius/gtfs/rt-tile/abc/6km/12_34",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        // POST not allowed
        assert_eq!(
            resolve(
                "POST",
                "/api/vilnius/gtfs/rt-tile/abc/6km/12_34",
                "vilnius",
                ListenerKind::Public
            ),
            Route::NotFound
        );
    }

    #[test]
    fn matches_poi_tile() {
        // No outer /api/<city>/ segment — cityId is the route's OWN first
        // segment, independent of whatever `--city-slug` this process runs.
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilnius/12km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("vilnius".to_string(), "12km".to_string(), "1_2".to_string())
        );
        // Fastify exposes HEAD automatically for GET routes. tiny_http
        // suppresses the body when responding to a HEAD Request.
        assert_eq!(
            resolve(
                "HEAD",
                "/api/gtfs/poi-tile/vilnius/12km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("vilnius".to_string(), "12km".to_string(), "1_2".to_string())
        );
        // Resolves for a landmark city that ISN'T the process's own
        // city_slug — the whole point of the city-agnostic route.
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/gdansk/12km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("gdansk".to_string(), "12km".to_string(), "1_2".to_string())
        );
        // query stripped
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilnius/12km/1_2?x=1",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("vilnius".to_string(), "12km".to_string(), "1_2".to_string())
        );
    }

    #[test]
    fn poi_tile_decodes_each_capture_like_fastify() {
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilniu%73/12%6bm/1%5f2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("vilnius".to_string(), "12km".to_string(), "1_2".to_string())
        );
        assert_eq!(
            resolve(
                "HEAD",
                "/api/gtfs/poi-tile/vilniu%73/12%6Bm/1%5F2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("vilnius".to_string(), "12km".to_string(), "1_2".to_string())
        );
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vil+nius/12km/1%2f2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile(
                "vil+nius".to_string(),
                "12km".to_string(),
                "1/2".to_string()
            ),
            "path plus is literal and an encoded slash stays inside its capture"
        );
    }

    #[test]
    fn malformed_poi_tile_encoding_routes_to_bounded_400_path() {
        for path in [
            "/api/gtfs/poi-tile/unknown/12%/1_2",
            "/api/gtfs/poi-tile/unknown/12%2/1_2",
            "/api/gtfs/poi-tile/unknown/12%GG/1_2",
            "/api/gtfs/poi-tile/unknown/12km/%FF",
            "/api/gtfs/poi-tile/unknown/12km/%E2%82",
            "/api/gtfs/poi-tile/%C3%28/12km/1_2",
        ] {
            assert_eq!(
                resolve("GET", path, "vilnius", ListenerKind::Public),
                Route::PoiTileBadUrl(path.to_string()),
                "{path}"
            );
        }

        let max = "a".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS);
        let max_path = format!("/api/gtfs/poi-tile/{max}/12km/1_2");
        assert_eq!(
            resolve("GET", &max_path, "vilnius", ListenerKind::Public),
            Route::PoiTile(max.clone(), "12km".to_string(), "1_2".to_string())
        );

        let encoded_max = "%61".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS);
        let encoded_max_path = format!("/api/gtfs/poi-tile/{encoded_max}/12km/1_2");
        assert_eq!(
            resolve("GET", &encoded_max_path, "vilnius", ListenerKind::Public),
            Route::PoiTile(max, "12km".to_string(), "1_2".to_string())
        );

        let overlong_decoded = "a".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS + 1);
        for overlong in [
            overlong_decoded.clone(),
            "%61".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS + 1),
        ] {
            let path = format!("/api/gtfs/poi-tile/{overlong}/12km/1_2");
            assert_eq!(
                resolve("GET", &path, "vilnius", ListenerKind::Public),
                Route::PoiTileParamTooLong(format!(
                    "/api/gtfs/poi-tile/{overlong_decoded}/12km/1_2"
                ))
            );
        }

        let astral_max = "\u{1f600}".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS / 2);
        let astral_max_encoded = "%F0%9F%98%80".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS / 2);
        for segment in [astral_max.as_str(), astral_max_encoded.as_str()] {
            let path = format!("/api/gtfs/poi-tile/{segment}/12km/1_2");
            assert_eq!(
                resolve("GET", &path, "vilnius", ListenerKind::Public),
                Route::PoiTile(astral_max.clone(), "12km".to_string(), "1_2".to_string()),
                "{path}"
            );
        }

        let astral_overlong = "%F0%9F%98%80".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS / 2 + 1);
        let path = format!("/api/gtfs/poi-tile/{astral_overlong}/12km/1_2");
        assert_eq!(
            resolve("GET", &path, "vilnius", ListenerKind::Public),
            Route::PoiTileParamTooLong(format!(
                "/api/gtfs/poi-tile/{}/12km/1_2",
                "\u{1f600}".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS / 2 + 1)
            ))
        );

        let bmp_max = "%E2%82%AC".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS);
        let path = format!("/api/gtfs/poi-tile/{bmp_max}/12km/1_2");
        assert_eq!(
            resolve("GET", &path, "vilnius", ListenerKind::Public),
            Route::PoiTile(
                "\u{20ac}".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS),
                "12km".to_string(),
                "1_2".to_string(),
            )
        );
    }

    #[test]
    fn poi_tile_edge_cases_are_not_found() {
        // too few segments
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilnius/12km",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileNotFound {
                method: "GET".to_string(),
                url: "/api/gtfs/poi-tile/vilnius/12km".to_string(),
            }
        );
        // too many segments
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilnius/12km/1_2/extra",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileNotFound {
                method: "GET".to_string(),
                url: "/api/gtfs/poi-tile/vilnius/12km/1_2/extra".to_string(),
            }
        );
        // trailing slash (empty final segment)
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilnius/12km/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileNotFound {
                method: "GET".to_string(),
                url: "/api/gtfs/poi-tile/vilnius/12km/".to_string(),
            }
        );
        // empty root
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileNotFound {
                method: "GET".to_string(),
                url: "/api/gtfs/poi-tile/".to_string(),
            }
        );
    }

    #[test]
    fn overlong_poi_capture_follows_find_my_way_walk() {
        let overlong = "a".repeat(MAX_POI_PATH_COMPONENT_UTF16_UNITS + 1);

        // Any of the three captures, before the segment count is known, and
        // for HEAD as well as GET.
        for path in [
            format!("/api/gtfs/poi-tile/{overlong}/12km/1_2"),
            format!("/api/gtfs/poi-tile/vilnius/12km/{overlong}"),
            format!("/api/gtfs/poi-tile/vilnius/{overlong}"),
            format!("/api/gtfs/poi-tile/vilnius/{overlong}/1_2/extra"),
            format!("/api/gtfs/poi-tile//{overlong}/1_2"),
        ] {
            for method in ["GET", "HEAD"] {
                assert_eq!(
                    resolve(method, &path, "vilnius", ListenerKind::Public),
                    Route::PoiTileParamTooLong(path.clone()),
                    "{method} {path}"
                );
            }
        }

        // The query is not part of the reported path.
        let path = format!("/api/gtfs/poi-tile/vilnius/{overlong}/1_2");
        assert_eq!(
            resolve(
                "GET",
                &format!("{path}?v=1"),
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileParamTooLong(path)
        );

        // A fourth segment is never a capture, and other methods have no POI
        // route to walk: both stay Fastify's route-level 404.
        for (method, path) in [
            (
                "GET",
                format!("/api/gtfs/poi-tile/vilnius/12km/1_2/{overlong}"),
            ),
            ("POST", format!("/api/gtfs/poi-tile/vilnius/{overlong}/1_2")),
        ] {
            assert_eq!(
                resolve(method, &path, "vilnius", ListenerKind::Public),
                Route::PoiTileNotFound {
                    method: method.to_string(),
                    url: path.clone(),
                },
                "{method} {path}"
            );
        }
    }

    #[test]
    fn fastify_decoded_path_keeps_reserved_escapes() {
        assert_eq!(
            fastify_decoded_path("/a/%25%2F%3f%23x%20%61%5F/%F0%9F%98%80"),
            "/a/%25%2F%3f%23x a_/\u{1f600}"
        );
    }

    #[test]
    fn poi_tile_not_gated_by_city_slug_but_is_loopback_and_method_gated() {
        // A cityId that matches NEITHER the process's own city_slug NOR any
        // real landmark city still parses as a Route::PoiTile — city
        // validity (CITY_ID_PATTERN, manifest membership) is the
        // handler's job, not the router's (same grammar-light-gate
        // division of responsibility as ScheduleTile/RtTile).
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/warsaw/12km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTile("warsaw".to_string(), "12km".to_string(), "1_2".to_string())
        );
        // Loopback listener never serves it (isolation contract).
        assert_eq!(
            resolve(
                "GET",
                "/api/gtfs/poi-tile/vilnius/12km/1_2",
                "vilnius",
                ListenerKind::Loopback
            ),
            Route::NotFound
        );
        assert_eq!(
            resolve(
                "OPTIONS",
                "/api/gtfs/poi-tile/vilnius/12km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileOptions
        );
        for path in [
            "/api/gtfs/poi-tile/vilnius/12%/1_2",
            "/api/gtfs/poi-tile/vilnius/12km/%FF",
        ] {
            assert_eq!(
                resolve("OPTIONS", path, "vilnius", ListenerKind::Public),
                Route::PoiTileBadUrl(path.to_string()),
                "{path}"
            );
        }
        // POST follows Fastify's route-level not-found response.
        assert_eq!(
            resolve(
                "POST",
                "/api/gtfs/poi-tile/vilnius/12km/1_2",
                "vilnius",
                ListenerKind::Public
            ),
            Route::PoiTileNotFound {
                method: "POST".to_string(),
                url: "/api/gtfs/poi-tile/vilnius/12km/1_2".to_string(),
            }
        );
    }

    #[test]
    fn auxiliary_listener_is_lifecycle_only() {
        for (path, expected) in [
            ("/health", Route::Health),
            ("/health/rt", Route::RtHealth),
            ("/ready", Route::Ready),
            ("/version", Route::Version),
            ("/metrics", Route::Metrics),
        ] {
            assert_eq!(
                resolve("GET", path, "vilnius", ListenerKind::Auxiliary),
                expected,
                "{path}"
            );
        }
        for path in [
            "/api/vilnius/plan",
            "/api/vilnius/raptor-bundle",
            "/api/gtfs/poi-tile/vilnius/12km/0_0",
        ] {
            assert_eq!(
                resolve("GET", path, "vilnius", ListenerKind::Auxiliary),
                Route::NotFound,
                "{path}"
            );
        }
        assert_eq!(
            resolve("POST", "/ready", "vilnius", ListenerKind::Auxiliary),
            Route::NotFound
        );
    }
}
