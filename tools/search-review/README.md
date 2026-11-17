# Local journey review bundles

Export a successful immutable stop-level engine capture:

```sh
node crates/pt-wasm/tests/baseline_review.mjs <capture-store> <run-id> <new-bundle.json>
```

The exporter verifies every retained artifact before writing a fresh file. It
does not overwrite existing exports, execute planner code, upload data or copy
raw artifacts into the bundle. Query and itinerary data can still contain
private locations and identifiers. Review the file before sharing it.

Version 1 (`ptn-search-review-bundle`) preserves the query, complete captured
candidate ordering, duplicate candidates, capture truncation, input/build hash
references, runtime, planning settings and the original reproducibility labels.
It omits performance samples and input file paths. It does not imply that an
unverified capture has been replayed.

The scope is **stop-level compiled engine**. Frontend endpoint resolution,
pedestrian geometry and applied real-time composition are outside this scope.
The bundle carries the capture's missing dependencies and unsupported fields.
It contains no map tiles or external map references.

`contract.mjs` is a portable validation module for the exporter and a future
local browser reviewer. SHA-256 identities bind the snapshot, query occurrence,
full candidate fields and ordered bundle contents. Object property order is
ignored; array order and unknown candidate fields are retained. These hashes
detect inconsistent or stale identities; they are not signatures proving who
produced the data. Subjective review actions belong in a separate format and
must not alter captured candidates or establish correctness.

Run the contract/export tests with:

```sh
node --test crates/pt-wasm/tests/baseline_review.test.mjs
```
