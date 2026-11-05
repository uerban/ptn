# Runtime city catalog

Serve `/deployment-config.js` with `Content-Type: application/javascript` and
`Cache-Control: no-cache`. The page loads it before the application module.
Schema 2 supports cities absent from the prebuilt frontend:

```js
globalThis.__PTN_DEPLOYMENT__ = {
  schemaVersion: 2,
  cities: [{
    id: "riga",
    name: "Riga",
    tz: "Europe/Riga",
    center: {lat: 56.9496, lon: 24.1052},
    bbox: {minLat: 56.8, minLon: 23.9, maxLat: 57.1, maxLon: 24.4}
  }]
};
```

Supply the complete host city list in picker order; the first is the default.
Every city needs a unique lowercase URL-safe ID, name, IANA timezone, map
center and bounds. Use bounds appropriate to the actual data; the timezone
must match the feed. The host must route `/api/<id>/` and install the city's
transit and OSM artifacts. Declaring a city does not install its data.

All frontend catalog lookups use these definitions, including timezone
resolution, location-based selection and saved-city restoration. Core metadata
overrides compiled entries with matching IDs; optional built-in behavior is
retained for those IDs. Optional `poiFetchMode` accepts `eager-bundle`,
`lazy-tile` or `server-side`. Invalid metadata fails startup rather than
silently selecting another city.

The complete catalog is retained for offline cold starts. A new online config
replaces the cached copy. Saved city IDs resolve against current metadata;
a removed city falls back to the first enabled city.

Legacy schema 1 (`cities: ["vilnius", "tricity"]`) still supports compiled
city IDs. Update deployment config generators to emit schema 2 with metadata
to add new cities. Null or missing config uses built-in development defaults.
Existing releases need one frontend upgrade to gain schema 2 support;
subsequent city additions require only host configuration and data changes.
