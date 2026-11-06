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

## Signed offline export

`pt-pack-export` copies a verified selection into a **new** staging directory:

```sh
cargo run -p pt-artifacts --locked --bin pt-pack-export -- \
  --generation /path/to/transit/generations/GENERATION_ID \
  --output /path/to/new-export --without-geometry \
  --signing-key /private/builder/transit-signing-seed.hex
```

The key file contains a 32-byte Ed25519 seed encoded as lowercase hex. Keep it
on the builder. The output contains `files/` with the original relative paths,
`selection.json`, and a raw detached `selection.json.sig`. The command prints
the descriptor's SHA-256. Full and geometry-free selections have different
descriptor hashes while retaining the same original pack ID.

The signature authenticates the exact descriptor bytes with the domain prefix
`PTN-TRANSIT-SELECTION-v1\0`. It binds all selected hashes, including generation
metadata and tile bodies. Verification requires separately configured public
keys and an expected city. It also rejects unsafe/duplicate paths and invalid
size totals. This signature provides no expiry or update sequence; a refresh
catalog must supply those before automatic remote installation is available.

Export streams and rehashes each copied file, rejects changed bytes, and refuses
to reuse an existing output. Normal failures remove the new output. A crash can
leave staging data; the descriptor is written last as a completion marker.
Keep both source and staging directories private and immutable during export;
never serve the staging directory while the command is running. This command
neither promotes a public channel nor performs native-format validation. Ops
must validate and promote a completed tree before exposing it.

## Offline refresh catalog

`pt-pack-catalog` prepares a signed transit head from one or two existing
exports. It authenticates each descriptor with configured public keys and
rechecks the exported files before writing a new offline directory:

```sh
cargo run -p pt-artifacts --locked --bin pt-pack-catalog -- \
  --selection /path/to/minimal-export --selection /path/to/full-export \
  --city CITY --sequence NEXT_SEQUENCE --expires-at 2026-12-06T00:00:00Z \
  --output /path/to/new-head --signing-key /private/builder/transit-signing-seed.hex \
  --trusted-key PUBLIC_KEY_HEX
```

The caller allocates a strictly increasing sequence from its publication ledger.
This command does not read or switch a live head, allocate sequences, or perform
native-format validation. Both exports must retain the same pack and generation
IDs; duplicate geometry choices are rejected. The output is `latest.json` with
its raw detached `latest.json.sig`. Keep the output offline until validation and
atomic promotion are implemented.

The signature domain is `PTN-TRANSIT-CATALOG-v1\0`, distinct from selection and
OSM signatures. The catalog binds each selection's exact hash, byte length and
geometry choice. Consumer verification requires a configured city and keys,
checks publication time and expiry, and rejects sequence rollback. Persist a
checkpoint containing both sequence and exact catalog hash after successful
installation: a different head at an already accepted sequence is rejected.
Local rollback must retain this checkpoint. Head expiry affects new updates,
not continued use of installed data.

The library's `verify_selection` checks the selection against an already
verified catalog and authenticates its signature. It does not download files,
validate native binary formats, activate a generation, or select server runtime
components. Those steps remain necessary before builder-free hosting works.
