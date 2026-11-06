# City discovery and device downloads

The backend deployment owns its configured city catalog. The same frontend
archive discovers it at `/api/cities`; new cities do not require a web rebuild.
Catalog membership is independent of temporary backend readiness or health.

## Host catalog

Serve JSON with `Content-Type: application/json` and `Cache-Control: no-cache`:

```json
{
  "schemaVersion": 2,
  "cities": [{
    "id": "riga",
    "name": "Riga",
    "tz": "Europe/Riga",
    "center": {"lat": 56.9496, "lon": 24.1052},
    "bbox": {"minLat": 56.8, "minLon": 23.9, "maxLat": 57.1, "maxLon": 24.4}
  }]
}
```

Every city needs a unique lowercase URL-safe ID, name, IANA timezone, center
and geographic bounds appropriate to its served data. The timezone must match
the feed. The host must route `/api/<id>/` and install transit and OSM data.
Declaring a city does not install data or prove a server is healthy.

The native host publishes `public-config/cities.json` and a city-specific
Caddyfile from its configuration. Its `cityMetadata` accepts explicit names,
center and bounds; `city-presets.json` is an optional onboarding input. The
same presets serve local development. They do not restrict production cities.
Multi-city deployment generators can call `catalog.publish_catalog` with all
accepted city configurations. Keep internal addresses, keys and feed
credentials outside the public descriptor.

Optional public metadata includes `transitSources`, `routeGroups`,
`defaultExcludedModes`, `poiFetchMode`, `poiCityIds` and `sharedMobility`.
These are explicitly validated by the client. Schema-2 cities do not inherit
hidden behavior based on a compiled city ID. GBFS requests still require the
user's explicit opt-in. POI mode accepts `eager-bundle`, `lazy-tile` and
`server-side`; `poiCityIds` describes constituent artifact areas.

## POI corpora

City discovery does not create POI data. A deployment must build, validate and
install each advertised corpus separately. Native validation accepts a corpus
whose ID matches its configured deployment city; Tricity retains its explicit
Gdańsk/Gdynia/Sopot mapping. Unknown cities do not inherit another city's data.

There is no corpus-count ceiling. Manifest and artifact byte limits still apply.
Decoded bytes for active tiled corpora, charged with a conservative memory
overhead factor, must fit the operator's configured budget
(`--poi-city-entries-cache-max-bytes`, or
`PT_SERVE_POI_CITY_ENTRIES_CACHE_MAX_BYTES` for the native server; the Node server
uses `POI_CITY_ENTRIES_CACHE_MAX_BYTES`). Whole-city eager corpora do not require
retained server-side decoded entries. The RSS guard reserves that budget plus
bounded metadata and in-flight decode/reference headroom. Namespace replacement
drops old cached ownership; invalid or over-budget updates retain the prior release.
New artifacts still require a compatible published native release and signed validation.

## Frontend exposure policy

The host's `/deployment-config.js` loads before the app. To show every city:

```js
globalThis.__PTN_DEPLOYMENT__ = {cities: "all"};
```

To expose a subset:

```js
globalThis.__PTN_DEPLOYMENT__ = {cities: ["riga", "tallinn"]};
```

Subset IDs must exist in the catalog. Empty, duplicate or unknown IDs fail
validation. This controls UI exposure; enforce API access restrictions in the
server/proxy separately. Serve this script with `Cache-Control: no-cache`.
There is no deployment-level default city.

## First launch

The frontend loads and validates discovery before starting transit services.
First launch shows a world map and accessible city buttons. Location lookup
starts only after the user presses **Use my location**. One unambiguous covered
city can be selected from the fix; overlapping or uncovered regions leave the
user in control. A previous valid user selection is restored on return.

Dots scale gently with geographic coverage area and stay between 6 and 16
pixels in radius. The selector clusters overlapping dots and retains a city
list and 44-pixel hit targets. Bundled public-domain Natural Earth land outlines
keep the overview independent of third-party map services.

## Offline use and device management

A cached catalog is metadata, not an offline city. It lets the app describe
known coverage during an outage. Unprepared cities are disabled offline and
labelled **Connect to download**; they are never presented as usable downloads. A discovery outage alone does not disable cities: the picker shows cached metadata
and allows connection attempts when the device is online. A complete current live cache
may also be opened offline and is labelled **Cached**, separately from explicit
**Downloaded** packages; only the latter survive a city switch.

While online, **Settings → Cities on this device** lets the user open and download or
update any exposed city and remove saved downloads. Each retained city also has an
**Open** action that restores its timetable without a network update, including
while offline. Opening a download does not change its download date. Downloading explicitly
requires a network-validated timetable, initializes the planner and requires declared walking
transfer bytes before saving a package. Failed updates retain the previous package and its date
and report the failure; offline fallback is not counted as a successful update. Packages retain PTB, canonical bundle
and display tables independently of the live city cache, so switching cities
does not remove explicit downloads. Only the chosen package is restored into
the active tables when offline or when the host is unreachable. Transfer bytes
are content-addressed and SHA-256 checked, including cache reads.

The manager shows the download date and an approximate package size. Downloads
can become stale or be evicted by the browser. These are timetable packages:
additional schedule tiles and policy-permitted places can be warmed using
**Prepare for offline**. That operation can be partial or budget-limited.
Live updates and server-only place search still need a connection. A package
does not promise every map, address or schedule detail is installed.

## Deployment requirements

Production deployments must publish the backend catalog at `/api/cities` and a
separate frontend exposure policy. The frontend discovers city definitions from
the backend catalog. The catalog, readiness and routing-bundle endpoints bypass
service-worker response caching; their loaders own validation and offline
fallback. Development builds may use presets without a discovery endpoint.
