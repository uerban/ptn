# Local search pilot ledger

`ledger.py` is a SQLite coordination layer for a small, explicitly materialized
offline search corpus. It uses the Python standard library and starts no
service. It does not yet provide a planner runner or command-line workflow.

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
Actual planner deadlines, retained artifact verification, process cancellation,
storage-budget enforcement, retry backoff, report generation and capture
reconciliation require the runner. The declared storage limit alone is not
proof of enforcement. No city-scale acceptance follows from ledger tests.

```sh
python3 -m unittest discover -s scripts -p test_search_pilot_ledger.py
```

The tests cover committed-claim recovery after killing a worker process, reopen
and resume, lease contention/expiry, bounded retries and reservations,
deduplication, immutable evidence and empty-success versus failure handling.
