# Retained local search replay

The replay module supports `ptn-search-finalization`, `ptn-search-composition`,
`ptn-search-reach` and `ptn-search-pipeline` version 1 records. Pipeline records
join the actual orchestrator query, reach, observed planner invocation/output,
direct walking and composition. Their scope is `frontend linked stages with
observed planner`: replay verifies stage continuity without re-executing the
planner or rebuilding its feed artifacts. Reach records re-run one directed
endpoint reach calculation from observed readiness, duration-table and transfer
lookup responses. Their capsule scope is `frontend directed endpoint reach`;
they need no query clock because this stage does not read one. They do not
retain the original provider graphs, endpoint selection or planner execution.
Composition records re-run post-planner
transfer walking evidence and itinerary composition before frozen RT/ranking;
they retain raw planner results and pedestrian responses rather than rebuilding
a graph or executing the planner. The module manifest declares supported formats.
Older manifests without this declaration support finalization records only;
existing retained finalization capsules remain readable without rewriting them.

Build a standalone replay module, retain an explicitly supplied finalization
record and module, then replay from content-addressed bytes:

```sh
node tools/search-finalization/cli.mjs build <new-module-dir>
node tools/search-finalization/cli.mjs capture <store> <id> <record.json> <module-dir>
node tools/search-finalization/cli.mjs replay <store> <id> <new-output-dir>
```

The build command uses the frontend's installed esbuild dependency. Its file
loader hands the compiler the same source buffers retained in the module
directory; the module manifest lists their names and SHA-256 digests. External
runtime imports reject the build. Compiler version/options are recorded, but
the compiler/resolver installation is not fully retained. The compiled module
bytes are the replay authority, not a promise of future source recompilation.

Shared constants/time/util/routing imports resolve explicitly to workspace TypeScript
sources, with compiler settings recorded. They do not require generated
`shared/dist` files or consume stale copies from a previous build. New shared
runtime imports need an explicit source mapping. A clean source-only-tree test
checks this before the shared package build runs in CI.

Capture verifies the supplied module and every source digest before retaining
anything. It reads the record without executing the module. Record, module,
build manifest, source buffers and replay child are retained by the existing
immutable baseline store APIs. Existing run IDs cannot be overwritten and no
cleanup or baseline promotion occurs. New store directories are private.

Replay verifies every declared artifact and its module provenance before making
a fresh output directory. The local Node executable digest, Node/V8, platform,
architecture and OS release must match the recorded **replay runtime**. It runs
the retained child source and imports the observed module bytes through a data
URL; neither is re-read from a mutable code pathname. Restored module/record
bytes are checked again by the child. The parent independently checks the
returned output against the retained record. `NODE_OPTIONS` and `NODE_PATH`
are removed from the child environment.

The child has a five-second default deadline (API accepts 1–30,000 ms) and a
4 MiB Node output-buffer limit. Timeout and errors produce verification records
with null output, separately from a successful empty result. Raw stdout/stderr
are retained; buffer-limit failures disclose incomplete logs. Output files are
private and never overwritten. Explicit replay executes retained trusted code;
the process deadline is not a security or network sandbox. Use an OS network
denial when verifying offline operation.

These capsules remain **partial captures** at their declared frontend stage.
Individual reach/composition/finalization records remain readable, alongside
linked pipeline records. Linked records still use an observed planner response;
they are not full-search engine execution captures. They do not retain endpoint selection,
planner execution, raw pedestrian graphs and route execution, or pre-lookup RT
feeds. Building a replay module after
importing a record also does not establish the original producer application's
bytes or browser runtime. That producer identity remains explicitly unverified.
Replay success establishes compatibility and exact output at this boundary,
not full search reproducibility, independent feasibility or human usefulness.

Precise locations and trip IDs can be present in records. All operations are
explicit local commands; production searches never call this tool and nothing
is uploaded automatically.

## Supplied planner artifacts

A pipeline capsule can be extended into a **new** immutable run with explicit
router state. This reads and retains bytes without executing them:

```sh
node tools/search-finalization/cli.mjs attach-planner <store> <source-id> <new-id> <glue.js> <wasm> <ptb> <transfers-path-or-none> <pattern-mode>
```

Use `none` to explicitly declare no separate transfer overlay. Pattern mode must
be `off`, `unbounded` or `covering-merge`; there is no inferred default. The
original capsule is retained as a hashed artifact, along with its original
replay child. Its record/module/source bytes and runtime contract remain linked.
The module must declare `ptn-wasm-query-v1` mapping support. Existing modules
without that declaration cannot silently gain planner replay support.

Replay first checks the linked frontend stages, then initializes the supplied
WASM from retained bytes, constructs its router with the PTB and explicit pattern
mode, installs the transfer overlay if supplied, and plans the query through the
same pure adapter used by production `planWithWasm`. Its complete ordered output
must equal the observed planner output. The parent separately checks this output
and artifact digests. A missing planner proof, mismatch, initialization/query
error or timeout cannot become a successful empty result. Planner files are
verified before materialization and checked again by the retained child. The
existing process deadline and output-buffer limit cover the entire replay.

The proof includes mapped engine query, exact supplied artifact hashes and planner
output. This verifies compatibility of the supplied state, **not** identity of the
original live router handle or its producer. Both identities remain explicitly
unverified, and capture classification/scope do not change. Original missing
fields remain documented in the source capsule. This does not rebuild the feed,
rerun endpoint selection or raw walking graphs, resolve the original time frame,
or establish original browser/worker lifecycle equivalence. No runtime package
or compiler installation is required for replay. Generated glue must be usable
from its retained data URL; external module/file dependencies are not captured.

## Supplied decoded walking graph

Composition and supported pipeline observations can be extended into another
immutable run without executing supplied code during attachment:

```sh
node tools/search-finalization/cli.mjs attach-walking <store> <source-id> <new-id> <glue.js> <wasm> <decoded.ptwg> <city> <default-or-wheelchair>
```

This retains the exact decoded graph bytes consumed by `PtWalkGraph`, not a
Brotli transport/release snapshot. City and profile are explicit. For pipelines,
the profile must agree with the recorded mobility profile. Composition-only
records do not retain that routing profile, so the supplied choice remains an
unverified state assertion. The exact request-builder source is retained too.

Replay constructs the graph, checks its city, and reruns each recorded transfer
route response (including an explicit null response). Pipeline replay also
checks a retained non-null direct route. Every call's coordinates, order, geometry,
distance and steps must match exactly. Typed transient/superseded outcomes cannot
be reproduced by a loaded graph and are rejected. An old pipeline with a null
direct route is ambiguous about absent/missing/unavailable providers and is
rejected for this attachment. An observation without pedestrian calls is also
rejected. These limits do not change ordinary observation replay support.

The child verifies its read buffers and imports the retained request builder by
value. The parent independently checks call proofs against the observation.
Missing proofs, city/profile mismatches, route differences, errors and timeouts
cannot become successful empty output. Planner and walking attachments can be
combined in either order; their glue instances are separate even when the bytes
are identical, so initializing one cannot reuse the other's WASM binding.

Original graph/live application identity remains explicitly unverified, and
original capsule scope/classification remain unchanged. This proves compatibility
of supplied decoded graph state for declared calls. It does not replay OSRM
endpoint duration tables, graph discovery/cache/worker lifecycle, decompression,
original city-scale graph state, or pre-lookup RT feeds. Use OS network denial
for an offline verification; the process deadline is not a security sandbox.

## Captured service-time conversion

New linked v1 observations may contain a `timeFrame` extension. Their module must
declare `ptn-time-frame-v1` support; an older module cannot silently ignore it.
The frame binds absolute query time to service date, origin and departure seconds.
Timezone conversions rerun from the captured explicit IANA zone, including a
resolved device zone when no feed zone was configured. Engine conversions remain
observed with arithmetic/clock checks until planner state is attached. Attached
planner replay calls supplied `PtRouter.resolveTime` and compares its complete
frame before planning. The parent requires that frame proof too.

Verification output distinguishes timezone recomputation, observed engine
conversion with arithmetic checks, and supplied engine conversion re-execution.
Legacy linked records without the extension keep their original contract; their
proof has no verified time frame. No stored record is rewritten or promoted.
Active-service computation and original live browser/router identity remain
outside this verification.

## Supplied frontend RT envelopes

The frontend receives a normalized binary `RouteUpdate`, not the upstream
GTFS-RT feed. This attachment verifies decoding and frontend store lookup for a
supplied history, without proving backend parsing or original live-state identity.

```sh
node tools/search-finalization/cli.mjs build-rt <new-rt-module-dir>
node tools/search-finalization/cli.mjs attach-rt <store> <source-id> <new-id> <rt-module-dir> <events.json>
```

History starts with an empty route map. Updates supply binary bytes and explicit
receipt stamps; removals preserve eviction/reinsertion order:

```json
[
  {"kind":"update","path":"route-update.bin","receivedAt":1794556800000},
  {"kind":"remove","routeIds":["old-route"]}
]
```

Paths resolve relative to the events file. Original manifest, consumed binary
buffers, normalized references, decoder module/build/sources and request helper
are retained. Capture executes no supplied module. Replay uses hashes and never
reads original paths. The decoder reuses the actual protobuf schema and production
store clamp/stamp/first-match helpers. Route replacement drops vanished trips;
repeated writes preserve insertion order. Receipt time governs overlay freshness.

The bundle retains consumed dependency/workspace source bytes. Its browser build
uses an explicitly retained empty fs stub; schema-file loading from disk is
unsupported and unused. It has no external runtime imports. Compiler/resolver
installation is not a hermetic rebuild promise; retained module bytes are replay
authority. No package/compiler installation is required for replay. The parent
checks every derived delay lookup and artifact proof. Corrupt/malformed protobuf,
mismatched stamps/values and missing proofs are errors, never empty success.

This static history is applied before all captured delay reads. A provider
changing between synchronous reads cannot be matched by this snapshot. Legacy
entries without receipt stamps are not reconstructed. Upstream GTFS-RT,
polling/consent/network scheduling, original provenance and unobserved fields
remain outside scope. RT may coexist with planner/walking attachments. Nothing
uploads data or enables capture for normal product searches.

## Read-only captured-output comparison

```sh
node tools/search-finalization/cli.mjs diff <before-store> <before-id> <after-store> <after-id>
```

Diff verifies every declared artifact/provenance link without executing retained
modules or requiring the current machine to match the old replay host. Recorded
runtimes must match each other. It reuses the baseline normalizer and field/multiset
diff: only object-key order is ignored. All candidate fields, array ordering and
duplicate counts remain visible. It never rewrites/promotes runs or assigns a
usefulness verdict. Replay verification is explicitly not evaluated by diff.

Comparability follows the declared boundary. Pure finalization pins composed
inputs; composition pins raw planner input; reach pins coordinates/stops/options
and lookup transcripts. Pipeline pins root query/reach inputs/settings and the
captured clock. Without supplied state it requires matching provider observations.
With supplied state it instead pins PTB/transfer/pattern data, decoded graph/city/
profile, or RT envelope history/receipt times; executable module/WASM versions may
differ and are reported separately. Legacy floor lookups remain observed, with their ordering pinned; captured
applied rule tables instead define that input state. Legacy clock conversion remains unverified. Different dependency
coverage, clocks, datasets or settings make comparisons incomparable. Unsupported
capture extensions are rejected from comparability rather than silently ignored.

Outputs remain fully visible even when inputs differ: added/removed rows,
ordering-only flag, positional field changes and input-change paths. Such changes
are confounded and carry no quality grade. An input-matched change is labelled
`changed/unreviewed`; equal captured outputs are `unchanged`. Neither status proves
successful replay, original live-state identity, feasibility or human usefulness.

For a minimal copied toolkit, replay still needs only the tool directory plus
`crates/pt-wasm/tests/baseline_store.mjs`. Diff additionally needs
`baseline_diff.mjs` and `baseline_glue.mjs` in that directory. Diff loads lazily;
normal replay does not acquire those extra dependencies. No frontend/compiler
installation is needed for either command.

## Captured applied transfer-floor rules

New orchestrator observations may contain `floorRules` in their finalization
record. An explicit getter captures all three applied JS maps after asynchronous
walking evidence and immediately before synchronous RT/finalization reads. It
retains exact stop-, route- and trip-scoped entries; no rules are inferred from
observed answers. Normal searches with diagnostic observers absent make no copy.

A module must declare `ptn-floor-rules-v1` capability for this optional v1 field.
Replay restores the tables and uses the retained production rule/key functions
for every floor lookup. Different calculated answers fail replay. Forbidden
transfers, timed/in-seat zero floors and fallback/minimum values stay distinct;
a zero floor still cannot permit boarding before physical arrival. The existing
finite-wire/2 MiB limit applies. Original GTFS/index generation is not established.

Proof distinguishes recomputed applied rules, captured rules with no actual floor
lookups, legacy observed answers, and an unused provider. Legacy records remain
readable. Diff pins captured rule tables while permitting code-driven answer
changes; without tables it keeps strict floor observations/interleaving instead.
Changes of table data are incomparable, never automatically a quality improvement.
