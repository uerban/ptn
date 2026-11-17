# Retained local finalization replay

The replay module supports both `ptn-search-finalization` and
`ptn-search-composition` version 1 records. Composition records re-run post-planner
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

Shared constants/time/util imports resolve explicitly to workspace TypeScript
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

These capsules remain **partial captures** of frontend RT feasibility/ranking.
They do not retain upstream endpoint/planner execution, raw pedestrian graphs
and route execution, or pre-lookup RT feeds. Building a replay module after
importing a record also does not establish the original producer application's
bytes or browser runtime. That producer identity remains explicitly unverified.
Replay success establishes compatibility and exact output at this boundary,
not full search reproducibility, independent feasibility or human usefulness.

Precise locations and trip IDs can be present in records. All operations are
explicit local commands; production searches never call this tool and nothing
is uploaded automatically.
