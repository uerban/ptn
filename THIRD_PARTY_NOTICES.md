# Third-party notices

This file covers third-party data and media copied into, or generated for,
PTN distributions. Software dependencies retain the license metadata published
with their source packages and recorded by the Rust and pnpm lockfiles.

## Open Sans glyph ranges

The files in `packages/frontend/public/glyphs/Open Sans Regular/` are SDF glyph
ranges generated from Open Sans and used for offline map labels.

Open Sans is Copyright 2011 The Open Sans Project Authors and is licensed under
the Apache License, Version 2.0. A copy of that license is included in
[`LICENSE-APACHE`](LICENSE-APACHE). The glyph source was distributed by the
[OpenMapTiles fonts repository](https://github.com/openmaptiles/fonts/tree/master/open-sans)
and encoded with [node-fontnik](https://github.com/mapbox/node-fontnik).

## OpenStreetMap-derived data

The committed micromaps in `packages/frontend/public/micromap/` and any POI
bundles built into `packages/frontend/public/poi/` contain data derived from
OpenStreetMap.

OpenStreetMap data is copyright OpenStreetMap contributors and licensed under
the [Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
These derived database files remain available under the same license. PTN shows
the required attribution in the app's About section and records source dates in
artifact metadata where available.

See the
[POI build instructions](packages/backend/scripts/README.md) for regeneration
details.
