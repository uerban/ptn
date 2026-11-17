# Local journey review bundles

Export a successful immutable stop-level engine capture:

```sh
node crates/pt-wasm/tests/baseline_review.mjs <capture-store> <run-id> <new-bundle.json>
```

The exporter verifies every retained artifact before writing a fresh file. It
does not overwrite existing exports, execute planner code, upload data or copy
raw artifacts into the bundle. Query and itinerary data can still contain
private locations and identifiers. Review the file before sharing it.

For readable stop names, `pt-core-emit review-stop-context <bundle.ptb>` exports
names and E7 coordinates through the compiled timetable reader, without building
a routing index or expanding services. Retain this JSON as `reviewStopContext`
using the baseline store APIs in a new immutable run, together with the extractor
executable/source provenance. Preserve the old run. The exporter verifies the
context artifact, its schema and its PTB hash, and includes only stops referenced
by query endpoints or leg endpoints. Labels are display context, not additional
engine results, pedestrian geometry or an independent correctness oracle.

Context is optional for version 1 bundles. The viewer shows `name (stop ID)` when
available and the original ID otherwise. Names render as plain text offline.
Enrichment changes bundle identity, so actions from the older bundle stay bound
to that older context. It does not upgrade capture or replay-verification labels.

Version 1 (`ptn-search-review-bundle`) preserves the query, complete captured
candidate ordering, duplicate candidates, capture truncation, input/build hash
references, runtime, planning settings and the original reproducibility labels.
It omits performance samples and input file paths. It does not imply that an
unverified capture has been replayed.

The scope is **stop-level compiled engine**. Frontend endpoint resolution,
pedestrian geometry and applied real-time composition are outside this scope.
The bundle carries the capture's missing dependencies and unsupported fields.
It contains no map tiles or external map references.

`contract.mjs` is a portable validation module for the exporter and the
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

## Review actions

`state.mjs` defines the separate `ptn-search-review-actions` version 1 format.
Each session has a reviewer identifier, a random seed and a retained blind
candidate assignment. Committed judgments include confidence, area familiarity,
reason codes and plain-text notes. Pairwise choices retain the displayed A/B
candidate identities, including equivalent, neither and cannot-judge answers.
An explicit skip is separate from a judgment. Unfinished form drafts are not
actions.

Sessions append actions rather than modifying them. Undo appends a reference
to an earlier action; exports preserve both records. Imports preserve separate
reviewer opinions without voting or replacing disagreement. Repeated imports
are idempotent. Divergent edits of the same session are rejected so neither
branch silently overwrites the other. Bundle and candidate changes invalidate
old actions instead of silently applying them to recomputed journeys.

The module provides creation, append, validation, effective-action and merge
functions. It performs no storage or network access. Browser persistence and
the interactive reviewer are separate consumers of this format.

```sh
node --test crates/pt-wasm/tests/baseline_review_state.test.mjs
```

## Open the reviewer

Open `index.html` directly in Chromium, then import a bundle and enter a
reviewer name or alias. The file includes its scripts and styles; it needs no
server, installation, map service or internet connection. Provenance is hidden
until requested. Alternatives use a retained randomized order, rather than
engine result order.

The page shows a stop sequence and exact service-day times (including hours
above 24), access/egress, waiting and transfers. Headway estimates retain
`~` markers on affected leg times and estimated journey totals, with an explicit
uncertainty explanation; scheduled-service times remain unmarked. It declares missing physical
walking totals and geometry. This is a schematic of the captured boundary, not
an inferred geographic route. Query constraints and settings are available
alongside the alternatives.

Draft fields and committed actions are saved separately in browser storage,
keyed by bundle identity. Export reviews to transfer committed actions between
browsers or recover them before moving the HTML file or clearing browser data.
Imports preserve independent opinions. Conflicting tabs or unavailable storage
leave in-memory reviews exportable and display a recovery message.

Use single-option judgments or pair comparisons. Save judgment commits an
opinion; Skip commits a separate action; Undo appends an undo event. JSON exports
retain the action history and blind assignments. Markdown exports contain the
active opinions and candidate references. Drafts are excluded from both.

Keyboard shortcuts are shown on the page. Imported text is rendered as text,
never HTML. A content security policy blocks external resources. Imports larger
than 10 MiB, 1,000 queries, 200 candidates per query or 5,000 total candidates
are rejected rather than silently truncated. These bounds are viewer limits,
not city-scale performance acceptance.

Rebuild the self-contained file after editing its sources:

```sh
node tools/search-review/build.mjs
node tools/search-review/build.mjs --check
node --test tools/search-review/browser.test.mjs
```

The browser tests use the frontend's existing Playwright installation and
installed Chromium. They cover actual offline reload, drafts, stable blind
order, explicit actions, undo, export/reimport, neutral/disagreeing opinions,
stale imports, safe text, storage failure and concurrent-tab recovery.

## Report imported review coverage

```sh
node tools/search-review/report.mjs <bundle.json> <new-report.json> [actions.json ...]
```

This local report validates the bundle and every action journal, merges repeated
or extended exports idempotently, and rejects stale identities or session forks.
It writes a fresh file with private permissions. With no feedback, evidence stays
`not-evaluated`; unreviewed cases never become neutral judgments.

Coverage distinguishes explicit opinions, substantive assessments (excluding
cannot-judge), skipped-only cases and unreviewed cases. Empty and truncated
captures remain in the denominator. The latest non-undone opinion for each
session and candidate/pair is shown; full history remains in the original action
exports. Skips do not erase opinions. Pair comparisons resolve A/B to candidate
identity before detecting different responses across blind assignments.

Individual opinions, confidence, familiarity, reasons and notes remain separate.
Session and alias counts do not prove independent human reviewers. Counts apply
only to the imported bundle; they are neither citywide satisfaction estimates
nor correctness verdicts. No overall quality score or baseline promotion is
produced. Reports can contain private notes and identifiers; sharing remains
an explicit separate action.

## Compare two retained captures

```sh
node crates/pt-wasm/tests/baseline_review_compare.mjs <store> <before-run> <after-run> <new-bundle.json>
```

The comparison exporter verifies both immutable captures and their artifacts
before creating a private, fresh output. PTB bytes, query-manifest bytes, ordered
queries, planning settings, explicit glue execution contract and core runtime
must match. Engine glue/WASM hashes may differ. Mismatches reject the comparison;
use the baseline diff tool to inspect incomparable inputs separately.

Version 2 comparison bundles retain both complete version 1 source bundles.
Each displayed candidate binds its source side, original rank and source
candidate identity. Duplicate occurrences remain distinct, including identical
itineraries from the two sources. Empty arrays and truncation remain visible;
combined capture truncation is true if either source is truncated. Case status
is `unchanged` or `changed/unreviewed`, based on the exact ordered itinerary
arrays. A status is not a usefulness or feasibility verdict.

The primary `provenance` and case snapshot belong to the before source; this is
explicitly recorded as `comparison.primarySource`. Both source provenance
records and displayed-option source assignments are available on demand in the
viewer. Candidate sources are hidden initially and session order remains blind
and stable through offline reload. The derived comparison is validated again
on import; changing source ranks, derived arrays or status invalidates it.

New exports record the execution contract explicitly. Older version 1 bundles
without that metadata still open individually, but cannot establish a portable
matched-execution comparison. Version 1 action journals work with either bundle
version and bind to that bundle's identity; feedback is never silently moved
between single-capture and comparison views. Older viewers that support only
version 1 must be updated to open version 2. No baseline promotion or automatic
quality verdict occurs.
