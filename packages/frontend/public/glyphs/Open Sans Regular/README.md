# Open Sans Regular — PBF glyph ranges

Subsetted SDF glyph PBFs for the "Open Sans Regular" fontstack, used as the
local-style fallback font when the Carto basemap is unavailable (see
the meta map offline notes).

- `0-255.pbf` — Basic Latin + Latin-1 Supplement
- `256-511.pbf` — Latin Extended-A + Latin Extended-B

Covers LT (Vilnius), PL (Gdansk), and other Latin-script deployments.
Cyrillic (1024–1279) and CJK ranges are not included; those deployments
should build with `VITE_MAP_LABELS_MODE=network`.

## Attribution

Open Sans is Copyright 2011 The Open Sans Project Authors
and is licensed under the Apache License, Version 2.0. The source font was
distributed by the [OpenMapTiles fonts repository](https://github.com/openmaptiles/fonts/tree/master/open-sans),
then encoded via [node-fontnik](https://github.com/mapbox/node-fontnik).
See the repository's [`THIRD_PARTY_NOTICES.md`](../../../../../THIRD_PARTY_NOTICES.md)
and [`LICENSE-APACHE`](../../../../../LICENSE-APACHE).
