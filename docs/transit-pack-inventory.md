# Transit pack inventory

`pt-pack-inspect` audits an existing local producer generation without running
builders, fetching feeds or installing anything:

```sh
cargo run -p pt-artifacts --locked --bin pt-pack-inspect -- \
  --generation /path/to/transit/generations/GENERATION_ID
```

Use `--without-geometry` to leave out SHPB and legacy shapes JSON. The selection
keeps the original `packId`; it does not rewrite the publisher's `pack.json`.
Omitted geometry need not exist locally. Selected geometry must match its
advertised hash and size. Stop coordinates, timetable and transfers remain
transit data independently of optional route shapes.

The JSON report lists selected paths, sizes and hashes, omitted geometry and
excluded extras. Historical manifests may list an optional address index; the
inspection excludes it without opening it. New producer manifests keep address
search outside the transit pack. Unsupported artifact kinds fail explicitly.

The command validates pack identity, matching generation metadata and the
selected artifact bytes. Advertised transit sidecars remain necessary even when
their generic `required` flag is false. It also follows the stop-cell map and
schedule subdivision manifest to inventory every referenced/declared tile body.
Existing pack manifests identify the tile manifest but do not hash these bodies
individually; the report records their local hashes for a later export contract.
It ignores unrelated generation directories such as extracted source feeds.

This command is an inventory tool, not a native-format validator, authenticated
publication or self-host installer. An inventory hash does not authenticate its
source. In particular, the tile-body hashes and generation metadata require
binding into an authenticated publication before remote installation can trust
them. It does not claim that the current server can load a partial generation
with shapes omitted; explicit runtime component selection is subsequent work.

OSM, address indexes and POI data are independent optional artifacts. Their
versions do not need to match the transit generation. The inspection does not
fetch or validate them and does not require their original build inputs.
