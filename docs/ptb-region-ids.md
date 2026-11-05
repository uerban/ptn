# PTB header byte map & region-ID registry

This document defines the PTB fixed header prefix, tagged region-table entries,
coordinate grid, and region-ID allocations. The supported public versions are
**1** and **2**, which share the header and entry layouts below.

Implementation: [header.rs](../crates/pt-core/src/header.rs) and
[region_ids.rs](../crates/pt-core/src/region_ids.rs). Registry tests verify IDs
and alignment against this table. Reserved allocations are not a promise that a
region is emitted or supported.

## 1. Fixed header prefix (little-endian)

The header occupies 4096 bytes. The region table starts at byte 32.

```
[0..4)    magic            "PTB\0"
[4..6)    version          u16   (1 or 2)
[6..8)    featureFlags     u16
[8..12)   numStops         u32
[12..16)  numRoutes        u32
[16..20)  numTrips         u32
[20..24)  feedStartDate    u32   (YYYYMMDD, civil date in feed IANA timezone)
[24..28)  numServices      u32
[28..32)  cityTzOffsetSecs i32
[32..)    region table
```

`featureFlags` bit0 is `hasFlex`, bit1 is `hasFares`, and bit2 is
`DERIVE_BLOCK_INSEAT` (v2 only). Producers write bits3–15 as zero.
`cityTzOffsetSecs` is an anchor-date offset snapshot for load-time validation;
runtime wall-clock calculations use the IANA timezone.
`windowDays` is stored in `0x01 WindowMeta`, rather than the prefix.

PTB v2 requires regions `0x18`, `0x19`, and `0x1A`. Its readers reject
unknown global feature bits; v1 does not validate reserved global bits.
`DERIVE_BLOCK_INSEAT` enables date-gated `block_id` in-seat derivation in v2.

The `0xF8 Transfers` region uses fixed 32-byte rows in both versions:
`from_stop u32`, `to_stop u32`, `from_route u32`, `to_route u32`,
`from_trip u32`, `to_trip u32`, `min_transfer_secs u32`, `transfer_type u8`,
and three reserved zero bytes. `0xFFFFFFFF` denotes an absent `u32` value.
V2 permits absent stops only on type-4/5 rows, which require both trips.

In v2, byte 15 of each 16-byte `0x17 Frequencies` row is `flags` (reserved in
v1): bit0 is `QUARANTINED`, and all other bits are zero. A quarantined trip
has exactly one marker row (`start 0`, `end 1`, `headway 1`, `exact_times 0`)
and is excluded from both frequency and scheduled-template routing. Other v2
rows require `headway >= 1`, `start < end`, and `exact_times` in {0, 1}.
Rows for each trip must be sorted by start without overlap. The end is exclusive
for every row, including `exact_times = 1`.

## 2. Region-table entries

Each entry is 24 bytes, with this little-endian layout:

```
[ 0.. 2)  regionId   u16
[ 2.. 4)  entryFlags u16
[ 4.. 8)  reserved   u32   (zero)
[ 8..16)  offset     u64   (absolute file offset)
[16..24)  length     u64   (bytes)
```

A zero-ID entry terminates the table within the 4096-byte header. The region
count is the number of entries before that terminator; it is not stored.
Producers zero unused header bytes. Entries are addressed by ID, independently
of table order, and IDs must be unique within a bundle. The reader rejects an
unterminated table, duplicate IDs, unrepresentable offsets or lengths, and
regions extending beyond the file (including arithmetic overflow).

`entryFlags` is zero unless a region defines flags. TripTimes defines the flags
listed in §4. Absence is returned by region lookup; required-region validation
is specific to the reader and format version.

## 3. Coordinate quantization grid

Stop coordinates and shape anchors use signed `i32` values at **degrees × 1e7**
(`lat_e7`, `lon_e7`). This preserves seven decimal places and fits the WGS84
latitude and longitude ranges.

The producer validates finite source `f64` coordinates with `|lat| <= 90` and
`|lon| <= 180` before multiplying, then rounds half away from zero:
`(x * 1e7).round()` in Rust. Readers consume the stored integers. Any other
quantizer must match this rounding rule, including negative half values;
JavaScript's `Math.round` differs there. Quantization must use source `f64`
coordinates, without an intermediate `f32` conversion.

## 4. Region-ID registry

`0x00` is the table terminator. Allocated IDs remain reserved even when their
regions are not implemented. Hot regions are used by routing or cast directly
from mapped bytes; cold regions are decoded at load time or used for rendering.

| regionId | Region | Availability | Tier | Align | Notes |
|---|---|---|---|---|---|
| `0x01` | `WindowMeta` | v1/v2 | cold | 2 | `windowDays u16`; absent defaults to 90; maximum 400 |
| `0x02` | `IntegrityTag` | Reserved | cold | — | Reserved for an integrity tag |
| `0x03` | `StringPool` | Reserved | cold | 4 | Reserved string-pool allocation; published bundles use `0xF7` |
| `0x10` | `Patterns` | v1/v2 | hot | 4 | Per-pattern stop offset/count/flags |
| `0x11` | `PatternStops` | v1/v2 | hot | 4 | shared `u32` stop-ordinal column |
| `0x12` | `PatternSemantics` | v1/v2 | hot | 1 | Packed pickup/drop-off/timepoint semantics; omitted for all-regular patterns |
| `0x13` | `TripTimes` | v1/v2 | hot | 8 | Dense trip times: `trip_first_dep u32`, dep/dwell deltas and served bits. `entryFlags` bit1 selects `i32` deltas instead of `i16`; bit0 (ragged) is reserved and rejected |
| `0x14` | `TripMeta` | v1/v2 | hot | 4 | Per-trip route/service/direction/wheelchair/bikes/block metadata |
| `0x15` | `ServiceBitfieldPool` | v1/v2 | hot | 1 | deduped distinct day-vectors, `ceil(windowDays/8)` B each |
| `0x16` | `ServiceToBitfield` | v1/v2 | hot | 4 | `u32` service→bitfield index |
| `0x17` | `Frequencies` | v1/v2 | hot | 4 | GTFS frequency rows keyed by TripMeta index; omitted when empty |
| `0x18` | `ServiceDayOrigins` | v2 | hot | 8 | PTB v2 only, mandatory there; `(effectiveWindowDays + 1)` LE `i64` Unix seconds, entry `i` = local noon minus 43,200 s on `feedStartDate + i` (GTFS `Time` origin); strictly increasing; last entry is the exclusive next-date origin |
| `0x19` | `BlockDerivationCommitment` | v2 | cold | 8 | PTB v2 only, mandatory there; 48 B: `algorithm_version u16 = 1`, 6 reserved zero B, `pair_date_count u64`, `tuples_sha256 [32]` over sorted `(source_trip u32, service_date_ordinal u32, target_trip u32)` LE tuples |
| `0x1A` | `CompatibilityArtifactCommitment` | v2 | cold | 8 | PTB v2 only, mandatory there; 88 B: `algorithm_version u16 = 1`, 6 reserved zero B, `v1_identity_size u64`, `v1_gzip_size u64`, `v1_identity_sha256 [32]`, `v1_gzip_sha256 [32]` |
| `0x20` | `Transfers` | Reserved | cold→hot | 1 | Reserved variable-row transfer allocation; published bundles use fixed 32 B rows at `0xF8` |
| `0x21` | `FootTransfers` | Reserved | hot | 4 | Derived same-station footpath CSR |
| `0x22` | `StopSideTable` | Reserved | cold | 4 | Reserved sparse stop optionals (stop_code, platform_code, level_id, …) |
| `0x23` | `RouteSideTable` | Reserved | cold | 4 | Reserved sparse route optionals (desc, url, sort_order, network_id) |
| `0x30` | `FeedMeta` | Reserved | cold | 4 | `feed_info` + `agency` singleton |
| `0x31` | `Translations` | Reserved | cold | 4 | Reserved translations allocation |
| `0x32` | `Languages` | Reserved | cold | 4 | language table for `Translations` |
| `0x33` | `Attributions` | Reserved | cold | 4 | render-only |
| `0x34` | `FareMedia` | Reserved | cold | 4 | `fare_media` display enums |
| `0x35` | `ColorPalette` | Reserved | cold | 1 | Reserved per-feed palette; current RoutesSoA colors use StringPool indices |
| `0x40` | `StopsSoA` | v1/v2 | hot | 4 | Columns in order: `id_idx`, `name_idx` u32; `lat_e7`, `lon_e7` i32; `parent_idx` u32 (`u32::MAX` = none); `wheelchair` u8 |
| `0x41` | `RoutesSoA` | v1/v2 | hot | 4 | Columns in order: `id_idx`, `agency_idx`, `short_idx`, `long_idx`, `color_idx`, `text_color_idx` u32; `route_type` u16. Colors are StringPool indices. NO derived `mode`/palette/flags |
| `0x44` | `StopIndex` | v1/v2 | hot | 4 | Sorted `(fnv32 u32, stringpool_idx u32, ordinal u32)`; full-string tiebreak |
| `0x45` | `PatternsAtStop` | v1/v2 | hot | 4 | CSR `sr_offsets[stops+1]` + pattern ordinals |
| `0x46` | `PatternTrips` | v1/v2 | hot | 4 | CSR `pt_offsets[patterns+1]` + trip ordinals |

Published bundles also use these record-region IDs:

- `0xF2` — TripsIntern (24-byte trip records).
- `0xF7` — StringPool.
- `0xF8` — Transfers (32-byte rows; see §1 for v2 constraints).

Producer staging bundles additionally use `0xF4` StopTimes, `0xF5` TripStarts,
`0xF6` Csr, and `0xFA` StopTimeBoarding. These are stripped after the pattern
regions are derived and are not part of the published timetable.

Sidecars are separate files with no region ID: `<bundle>.shapes.bin` (SHPB v2,
`i32@1e7` latitude/longitude pairs; no `shape_dist_traveled`),
`<bundle>.calendar.json`, `<bundle>.fares.json`, `<bundle>.flex.json`, and
`<bundle>.pathways.json`. Absent means the feed has none; malformed content is
an error.

## 5. Alignment

Region payloads use the natural alignment listed in §4. In particular,
TripTimes and the v2 time/commitment regions require 8-byte alignment, while
32-bit columns require 4-byte alignment. Payloads do not require page alignment.
