# City cache and map performance review

Worktree: `ptn-perf-investigation`; branch: `investigate/city-switch-performance`.
Base: `rework/transit-packs-v0.1.3`, `e4420d996b66b97593db7aedd8474cc521f220eb`.
Status: implementation, review and local acceptance checks complete.
Logical commits are pushed to the investigation branch; no deployment is included.
The implementation, browser regressions and evidence are committed separately
on the investigation branch and pushed to `uerban`. The original product
checkout and ops worktree are unchanged; other repositories need no changes.

## Findings and resulting behavior

The slow path existed before multi-city retention. A fresh pre-feature source
snapshot with identical feed bytes took 18.20 seconds to activate Krakow,
including a 15.57-second display-table write. The rework base repeated the same
cost with zero retained packages. Retention additionally made startup, cache
replacement and optional disk traffic expensive; it was not a necessary cause
of the measured switch delay. The deployed source and rework base have identical
map/cache/activation source; their only frontend source difference is the
backend-status display. Live staging performance remains unmeasured here.

The selected city now identifies an independently stored city. Verified raw
artifacts are retained by city/publication, one decoded context is active, and
readers validate captured city/generation/epoch after asynchronous work. Worker
decode feeds the index directly. A single empty standby worker avoids repeated
module startup; used workers terminate, and obsolete decodes abort. Optional
persistence starts after readiness;
the modern path performs no six-table projection copy or duplicate full API
stop-cache write. API enrichment remains in memory, with an atomic durable
snapshot retained for API-only fallback. Selection and reset do no disk clears.

User data follows city identity: saved places, Home/Work, ordering, route groups,
transport palettes and permitted viewports. Indexed city selection precedes
private payload materialization/decryption. Legacy explicit ownership and the
Gdansk alias survive; ambiguous saves remain in explicit recovery. Disabled
transport modes and general/accessibility/privacy preferences remain global.
City defaults are derived without changing global intent.

Urban entry shows names/dots before qualified activity. Recent valid verdicts
survive refresh and city revisits without renewing their resolution timestamps.
Inactive histories share a 4,000-stop budget with the active viewport, with at
most eight inactive contexts; active viewport coverage takes priority. Reuse
requires the same minute, publication, city, catalog, timezone and lookahead.
Pending/unavailable and authoritative empty are separate.
Publication identity gates new tile activity, while grouped reads share fetch
and decode work with bounded concurrency and LRU(2).

Visible inactive representations fade for 200 ms and become inert immediately.
Actual rendered dots/labels and card bounds determine visibility, including a
visible card/label whose dot is outside. Offscreen exits retire promptly. Exits
stay outside placement/application data, cancel on reactivation or real
city/publication replacement, and respect reduced motion. First qualification
of pending names in the same city can start a fade; an unchanged background
refresh does not cancel one.

Point-source identity follows geometry/properties, so badge-only changes call
no `setData`. Geometry-only spatial queries provide both label and card
candidates; latest activity objects and stable ordering are preserved. Placement
requests coalesce per frame, equivalent offsets avoid marker rerenders, font
loads invalidate measurements, and optional hint derivation yields in roughly
4 ms batches. Individual physical groups remain indivisible; this is not a
hard 4 ms task guarantee. Stop coverage remains unclustered at its intended zooms.

## Performance evidence

Reference: Apple M4 Pro, native ANGLE Metal, 1000×700 browser viewport, native
performance clocks and fixed transit responses. These are desktop observations.

| Gate | Result | Evidence |
| --- | --- | --- |
| Warm p95, 100 alternating arrivals | Vilnius stable cards 289 ms; Krakow 780 ms; every activity sweep complete, zero fixture misses | `final-sustained-summary.json` |
| Large-city warm p95, 100 alternating arrivals | Oslo index/activity/stable cards 798/824/988 ms; every sweep complete, zero fixture misses | `final-oslo-sustained-summary.json` |
| Cold p95, ten fresh contexts, local work after verified acquisition | Index 532 ms; activity 772 ms; stable cards 1,653 ms | `cold-replays-summary.json` |
| Metadata, 100 empty/8-legacy/8-indexed probes per engine | Zero payload reads; Chromium p95 0.2 ms, WebKit 1 ms; no eight-city increment | `metadata-discovery-summary.json` |
| Heap under sustained switching | Bounded last-20 ranges per city; raw memo ≤2 generations/24 MiB; no inactive decoded-city memo | `final-sustained-summary.json` |
| Dot/label/card zoom × all/urban pan | All six cases 16.8–17.6 ms p95; no long tasks or fixture misses | `final-pan-zoom-matrix.json` |
| Planner cold start, fast and real CPU throttle | Total p95 21/44 ms; all component budgets pass | `engine-coldstart-summary.json` |

The matched 0/1/8 retained-city comparisons remove the old projection
transaction. Krakow improved from roughly 18 seconds to 1.3–1.4 seconds; Oslo
from 22.13–23.09 seconds to 1.37–1.41 seconds. These one-run-per-cell storage
comparisons predate the final rendering fixes and are explicitly not p95.
See `fixed-feed-matrix.json`, `oslo-fixed-feed-matrix.json` and
`pre-retention-fixed-feed-summary.json`.

## Correctness and review

- Current source: **405 unit files, 4,616 passed, one existing skipped case**;
  NY/Vilnius suites pass 30/32 tests with their existing zone-conditional skips.
  Typecheck, source lint, WASM package check, i18n check, production build,
  precompression and optimized diagnostic build pass.
- All ten Chromium/WebKit map and privacy cases pass on a fresh Vite server.
  A prior HMR-contaminated source harness observed duplicate store identities;
  restarting Vite resolved it without a product change. The expanded real-map fade
  harness covers visible-dot/card/label edges, offscreen buffer removal,
  pan-out/back, reactivation without remount, reduced motion, city replacement,
  actual unchanged refresh, and zero badge-only source writes.
- Never-settling optional persistence tests prove index and planner readiness
  can complete independently. Real engine cold-start and built offline routing
  supplement the seam tests.
- Pins verify and durably repair missing/corrupt raw payloads; required sidecars
  precede atomic completion. CAS, cancellation, quota failures, leases and clear
  epochs preserve prior complete data and prevent cache resurrection. Ordinary
  retention is 64 MiB with active/pinned/in-flight exemptions; shared blobs are
  counted once, and unknown legacy owners are preserved conservatively.
- Actual interrupted v2→v7 upgrades and retry preserve data in Chromium/WebKit
  without upgrade payload reads. Unchanged v2 readers reopen v7 without
  destructive recovery. Final built Workbox update preserves saves and packages
  with an old reader held open; all four real offline reload/routing cases pass.
- All eight deployed catalogs pass captured and deterministic two-visit replay
  coverage on the final map/activation source; all 16 visits complete without
  fixture misses. Overnight Tbilisi can
  legitimately have no urban cards, with 25 viewport stops fully resolved.

Review also fixed a retained first-context listener, stale A→B→A preload
completion, publication-skew badge installation, switch-time legacy deletes,
late optional stop writes, offline restoration probing other cities, and
browser offline mocks that continued serving API responses. Routing golden
behavior, PTB format and routing algorithms are unchanged.

The [completion audit](completion-audit.md) maps requirements to evidence.
This review links current acceptance artifacts; other captures preserve
investigation checkpoints. Remaining staging/physical-device checks belong to
the manual release sequence and later PR aggregation. No deployment is included.

## Final warm-gate follow-up

`final-oslo-sustained-summary.json` records a fresh 100-switch run after bounded
activity-history reuse, empty-worker prewarming and removal of the redundant
200 ms wait after a terminal map event. Vilnius index/activity/stable-card p95
is 257/279/316 ms; Oslo is 798/824/988 ms. Every activity sweep completes, every
500 ms stability observation is confirmed, and there are zero fixture misses.
Oslo last-20 observed heap ranges from 209.7 to 211.7 MB. The warm gate passes.
The historical failed checkpoint below is retained as investigation evidence.

## Earlier snapshot checkpoint

At the earlier checkpoint, the additional 100-switch Vilnius/Oslo run
completed all activity/stability checks and kept memory bounded, but **did not
meet the provisional one-second warm gate**. Oslo index/activity/stable-card p95 is 1065/1342/1379 ms.
See `oslo-sustained-summary.json`. The remaining cost at that checkpoint was worker decode plus initial
display/activity work, rather than the removed projection transaction.
Do not treat the passing Vilnius/Krakow gate as universal city coverage.

## Final acceptance

Final built offline, worker-update and engine checks pass. The six-case pan
matrix passes at 16.8–17.6 ms p95 with no long tasks; final
eight-city replay completes all 16 visits. Release promotion remains separate.

Settings now explains app-wide versus city ownership; the accessibility palette
is labelled for all cities and custom mode colours name the current city. All
11 locale files have the new copy. The final copy-only adjustment passes 117
settings tests in 20 files, typecheck, lint, i18n parity, build and precompression.
The map/activation source used by the numerical reports is unchanged by this copy.
