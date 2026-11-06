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
labelled **Connect to download**; they are never presented as usable downloads. A complete current live cache
may also be opened offline and is labelled **Cached**, separately from explicit
**Downloaded** packages; only the latter survive a city switch.

While online, **Settings → Cities on this device** lets the user open and download or
update any exposed city and remove saved downloads. Downloading explicitly
loads its timetable, initializes the planner and requires declared walking
transfer bytes before saving a package. Packages retain PTB, canonical bundle
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

## Migration

Existing releases need one frontend upgrade for discovery. Legacy inline
schema-1 ID allowlists and schema-2 full definitions remain compatible, but
new deployments should publish the backend catalog and a separate exposure
policy. Development builds may use presets without a discovery endpoint.
