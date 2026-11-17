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
The runner implements those boundaries below. A representative stratified corpus remains separate work. Retry scheduling is
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
