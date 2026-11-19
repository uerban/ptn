# Local search pilot ledger

`ledger.py` is a SQLite coordination layer for a small, explicitly materialized
offline search corpus. It uses the Python standard library and starts no
service. The POSIX `runner.py` command connects it to the existing supervised engine capture runner.

A version 1 `ptn-search-pilot` manifest declares a corpus seed, feed timezone,
engine artifact hashes, planning settings, query jobs, sampling strata and
reported/random/holdout/synthetic partitions. These labels describe the supplied
corpus; they do not prove that sampling is unbiased. Duplicate query/build jobs
are rejected.

The manifest and jobs are immutable. Claims append attempts; completions append
results. SQLite triggers refuse updates and deletions of evidence. A successful
zero-candidate result is distinct from error, timeout, abandonment or
cancellation. Completed jobs are not claimed again. Retries never replace prior
attempts.

Transactions coordinate one worker lease. An expired or superseded worker
cannot renew or release another worker's lease. Recovery waits for any claimed
attempt's declared deadline before reserving another query, because a dead
worker may have left a bounded child alive. Attempt expiry records an abandoned
ledger observation, not a claim that the planner returned no route. A late
completion cannot overwrite that observation.

The ledger enforces at most 50 materialized jobs and three attempts per job,
with conservative execution-time reservations including finalization grace.
The ledger alone does not enforce a planner deadline or inspect retained files.
The runner implements those boundaries below. Sampling of a bounded declared stop population is described below; representative
city coverage remains unestablished. Retry scheduling is
described below. Read-only reporting is described below. No
city-scale acceptance follows from ledger tests.

```sh
python3 -m unittest discover -s scripts -p test_search_pilot_ledger.py
```

The tests cover committed-claim recovery after killing a worker process, reopen
and resume, lease contention/expiry, bounded retries and reservations,
deduplication, immutable evidence and empty-success versus failure handling.

## Execute one local attempt

Prepare a manifest as above, referencing the hashes in a successful immutable
source capture. The initial runner supports these settings only:

```json
{"objective":"plan","patternMode":"covering-merge","glueExecution":"snapshot","iterations":2,"warmup":0}
```

Also declare `limits.attemptFileBytes` between 64 KiB and 16 MiB. `init` verifies
all source artifacts before creating a fresh private snapshot directory. It
retains the source manifest and the capture runner's actual module bytes. A
retained producer timezone specification, when present, must match the declared
pilot timezone; otherwise timezone context is labelled caller-declared.

```sh
python3 tools/search-pilot/runner.py init <new-pilot-dir> <capture-store> <source-run-id> <plan.json>
python3 tools/search-pilot/runner.py step <pilot-dir>
```

Each `step` claims at most one attempt, then exits. Invoke it again to resume;
completed jobs are skipped. It pins Node executable/version, host, Python and
worker-source hashes, verifies every retained input again, and refuses a changed
runtime. Create a separate pilot for a different build/runtime. `--node` selects
the local executable explicitly. Unrecorded Node preload options are removed.

Every attempt has a fresh query file, raw stdout/stderr, process-group metadata
and an immutable capture run. Two iterations check exact ordered candidate
repeatability. The existing supervisor enforces the child deadline; an outer
process-group deadline adds finalization grace. SIGINT/SIGTERM cancellation
kills the group and retains a cancelled outcome. A killed worker can later
reconcile a completed capture after checking its query, inputs, settings and
runtime. Reconciliation never overwrites an existing result.

The storage boundary combines conservative admission for known runner outputs
and a POSIX per-file size limit. It is **not** a filesystem-wide quota against
arbitrary trusted glue or detached subprocesses. A limit failure may prevent a
complete capture; raw files and the failed attempt remain. Runtime execution
reservations include finalization grace but exclude initialization, input
verification, orchestration and operator wait time. This is not a memory budget.

The driver does not enforce network isolation. Retained JavaScript is executable
trusted code. Use OS-level network denial for a frozen offline experiment, and
retain that command separately. Captures remain partial: frontend geometry/RT,
producer rebuild, Node shared-library retention and external glue dependencies
are outside this boundary. Neither a successful empty query nor a completed
pilot establishes that no useful journey exists.

```sh
python3 -m unittest discover -s scripts -p 'test_search_pilot_*.py'
```

Runner tests exercise the real Node capture/supervisor with controlled glue.
They cover resume, capture-to-ledger interruption, mismatched query rejection,
empty success versus errors/timeouts (including an early timeout), output and
storage admission limits, changed runtime/inputs, and actual process-group
cancellation. The cancellation probe needs local POSIX process inspection.

## Inspect retained evidence

```sh
python3 tools/search-pilot/report.py <pilot-dir> --out <new-report.json>
```

The report opens a read-only transactional ledger view and refuses to overwrite
an export. It verifies the manifest/job table, retained input hashes, capture
query/settings/runtime contract, immutable manifest references and declared raw
log digests. A declared success is counted as a verified empty or nonempty
capture only when those checks pass. Pending, expired-pending, retryable,
attempts-exhausted, not-started and invalid-evidence jobs remain distinct.
Reporting does not reconcile or mutate jobs.

Cost includes known attempt elapsed time, unknown-time counts, reserved execution
budget and current retained bytes. Unknown interrupted durations are not filled
with zero. Filesystem inspection follows the transactional ledger read and is
not a globally atomic filesystem snapshot. Storage bytes are observed before
exporting the report. Initialization, verification and operator wait are outside
the recorded attempt elapsed time.

Coverage groups the declared partition, stratum, service date and mobility
request. These labels do not establish representative sampling or prove that
an engine honors a constraint. Review yield remains not evaluated until review
actions are supplied; absent reviews are not counted as zero-quality results.

Version 1 candidate diagnostics inspect projected leg chronology, stop
continuity, mapped entry boarding and available occurrence snapshots. Findings
require investigation. No findings means only that those fields produced no
findings; this is not an independent proof of service eligibility, transfer
rules, physical walking, RT feasibility or overall journey correctness. A
verified behavioral capture can still have diagnostic findings. Quality verdicts
remain separate and are never inferred from capture equality.

Reports retain the partial reproducibility classification. They do not certify
network isolation, authenticate a producer with signatures, replay the engine
or upload data. Exports are private by default and may contain identifying
sampling labels or error paths; sharing remains an explicit separate action.

## Durable retry scheduling

New runner pilots default to `limits.retryBackoffMs: 1000`. An explicit value
must be between 1 and 60,000 milliseconds. After a failed, timed-out or cancelled
attempt, the delay doubles with the attempt number, capped at 60 seconds. The
anchor is when the ledger recorded the result, not the query's departure clock
or an invented engine completion time. An abandoned attempt uses its recorded
expiry observation. Older ledger records without a timestamp use their declared
attempt deadline as a conservative fallback.

A deferred retry does not block a fresh eligible job. When only deferred jobs
remain, `step` returns `retry-backoff`, `retryAtMs` and `retryAfterMs`, without
sleeping, reserving another attempt or starting another capture. Reopen/resume
uses the same persisted timestamps and policy. Backoff wait is outside the
execution-time reservation; retries still obey their original count and
execution limits. No automatic background loop is introduced.

Version 1 manifests predating this field retain their original immediate-retry
policy when the field is absent or zero. New runner initialization requires a
positive policy; it never rewrites an old manifest. Existing execution runtime
pins still apply. Old ledgers remain readable by the report, which distinguishes
`retry-backoff` from `retryable` using the same policy function as the scheduler.
Raw failed attempts remain visible after a later successful retry.

## Materialize a bounded stop-level corpus

`pt-core-emit stop-universe <bundle.ptb>` exports the compiled stop IDs and exact
E7 coordinates through the existing reader. It hashes the observed PTB bytes,
builds no routing index and does not expand the timetable. Retain the JSON and
extractor executable/source provenance alongside the original capture.

The sampler consumes retained artifacts named `samplingStopUniverse`,
`samplingSpec`, `samplingGeneratorSource` and `samplingGeneratorLedger` in a
successful immutable source run. The last two must match the sampler and ledger
source files. Attach them using the existing content-addressed baseline store
APIs; the sampler itself never edits the store.

```sh
python3 tools/search-pilot/sample.py <capture-store> <source-run-id> <new-plan.json>
```

The sampling spec uses format `ptn-search-sampling-spec`, version 1, and declares
`seed`, `timezone`, finite `bounds` (`south`, `west`, `north`, `east`), optional
`reportedTupleIndices`, the runner `settings`/`limits`, and explicit `strata`.
Each stratum has a unique `id`, valid `date` (`YYYYMMDD`), `departureSecs`, engine
`mobilityProfile`, `maxRounds` within 1–4, and integer `random`/`holdout` counts.
At least one random and one holdout query are required across the corpus. The
entire plan stays within 50 jobs and its declared lower job cap.

Population rows are validated before selection; malformed/duplicate IDs or E7
coordinates fail. Generated origins/destinations are distinct compiled stops
inside the rectangle, with zero endpoint walking. Retained controls are preserved
separately and may fall outside the generated population. Date/time/mobility
strata are supplied explicitly, not inferred from the current clock.

The versioned SHA-256 counter stream uses rejection for bounded integer draws,
then rank selection without replacement. It never materializes the full stop
Cartesian product. Exact controls and previously drawn queries are excluded.
Holdouts are exact-query-disjoint, not geographically disjoint or a demand
holdout. Sampling is uniform over eligible ordered distinct stop pairs within
each declared stratum, not uniform over geography, residents or rider demand.
Changing holdout counts does not reshuffle ordinary random queries.

The output records the input/spec/population hashes, rectangle, stratum counts,
algorithm version and Python version. Identical retained inputs/runtime produce
identical plans. Over-capacity quotas fail instead of truncating. This does not
establish door-to-door access, physical pedestrian connectivity, complete city
coverage or journey usefulness. Those remain separate evaluations.

## Check candidates against published GTFS

`timetable.py` independently checks compatibility with a retained source GTFS
ZIP. It uses no planner code, downloads nothing, extracts no archive members to
disk, and does not mutate a pilot ledger. Supply the original source archive and
stop-level candidate snapshots, rather than a compiled PTB file:

```sh
python3 tools/search-pilot/timetable.py \
  --gtfs source.gtfs.zip --cases dated-candidates.json --out new-timetable-report.json
```

The input has this shape. Replace the digest and example identifiers/times with
retained evidence. Each case's `serviceDate` identifies the **query** time origin;
it does not assert that every leg runs on that service date.

```json
{
  "schemaVersion": 1,
  "sourceGTFSsha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "timeFrame": {"kind": "gtfs-service-origin", "timezone": "Europe/Vilnius"},
  "cases": [{
    "id": "example",
    "serviceDate": "20261113",
    "candidates": [{"legs": [{
      "type": "transit", "tripId": "trip", "routeId": "route",
      "fromStopId": "a", "toStopId": "b",
      "patternStopIds": ["a", "b"], "boardStopIdx": 0, "alightStopIdx": 1,
      "departSecs": 36000, "arriveSecs": 36600
    }]}]
  }]
}
```

`timeFrame` declares that projected seconds are elapsed seconds from local noon
minus twelve elapsed hours on the query date, following the
[GTFS time definition](https://gtfs.org/documentation/schedule/reference/#field-types).
The checker requires the declared timezone to match the source's shared
`agency_timezone` and fingerprints the IANA timezone-rule bytes it actually uses.
It checks compatibility under this declared contract; it does not prove that a
captured engine used that frame or that the source produced a particular PTB.
If the declaration is absent, timing and service eligibility remain unevaluated.

A compatible source service origin is derived from the projected endpoint
instant minus its published stop time. It must equal local noon minus twelve
elapsed hours for an actual service date. Two valid but different endpoint
origins produce a finding. If one endpoint establishes a unique origin, the
other is compared against that same origin; a missing published time remains
unevaluated. The report records the derived date, both origins, and which
endpoints establish it. It never rounds a difference to a day, adjusts candidate
times, or substitutes the query date for a leg date. This handles next-day trips,
previous-day trips with published times over 24 hours, and DST origin intervals
of 23 or 25 elapsed hours. Ambiguous or nonexistent local noon is unsupported.

Checks cover exact trip/route identity, weekday and inclusive date range,
`calendar_dates` overrides (including dates-only feeds), published boarding and
alighting times, and pickup/drop-off restrictions. Stop occurrences use explicit
indexes and require the entire source/candidate stop prefix through alighting
to match. No subsequence search or first-matching-stop substitution is used.
Differences strictly after alighting do not affect those occurrences; the report
records both pattern lengths and whether the full patterns match. Stop sequence
numbers are sorted numerically and need not be contiguous or equal the indexes.

Each diagnostic is `checked`, `finding`, `source-invalid`, or `not-evaluated`.
Findings require investigation; they are not automatically planner defects.
Frequency expansion (both `exact_times` modes), conditional pickup/drop-off,
missing source times, unaligned occurrences, flexible-service constraints and
non-transit legs remain explicitly unsupported or unevaluated. Malformed
referenced source rows and structural input errors are rejected. This is not a
complete GTFS feed validator.

The output records source/case digests and diagnostic counts. It is created
exclusively with private file permissions; existing outputs, including symlinks,
are refused. Exit code 2 means findings or invalid-source diagnostics were
retained; 0 means neither was emitted, and can still include unevaluated checks
or empty candidate lists. Other nonzero exits indicate invalid input or an I/O
failure. No exit code establishes journey feasibility or acceptance.

Operational input limits are 16 MiB case JSON, 64 MiB compressed GTFS, 128 MiB per
read table, four million rows per table, 50 cases, 256 candidates per case, 256
legs per candidate, 1,024 referenced trips and 8,192 occurrences per referenced
trip. These are diagnostic-tool admission limits, not routing resource budgets.
Pedestrian reachability, connection/transfer rules, real-time composition,
accessibility, candidate completeness/ranking and human usefulness remain
separate evaluations. `qualityVerdict` stays null.
