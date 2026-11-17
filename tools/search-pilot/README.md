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
The runner implements those boundaries below. Automatic retry backoff, aggregate
reporting and a representative stratified corpus remain separate work. No
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
