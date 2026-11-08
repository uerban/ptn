# City-switch performance investigation — 2026-11-06/07

Investigation branch: `investigate/city-switch-performance`, worktree `ptn-perf-investigation`.
Source baseline: `12766c0` (public main). Production release revision: `005932ef` (v0.1.2).
The intervening frontend changes do not change the map/hooks investigated here.
This section records the original investigation before implementation. The
current implementation uses `rework/transit-packs-v0.1.3` (`e4420d99`) as its
base. See [implementation review](implementation-review.md) for current scope,
validation and open acceptance gates. Nothing has been deployed.

## Findings

Two mechanisms combine: slow persistence delays authoritative urban filtering, and
independent loaders expose contradictory intermediate display states. The badge
sequence is reproducible in a focused hook test. Production browser captures
confirm fast initial cards followed by much later filtering and card removal.
The complete reported sequence was not observed in every live run; ordering varies.

### 1. Timetable persistence dominates the measured city-switch delay

Fresh Chromium context, 1000×700 viewport, software WebGL, Vilnius → Krakow,
zoom 16. A synthetic terminal user `moveend` follows a map jump, exercising the
pan-to-switch handler. This measures data readiness after arrival, excluding the
normal animated flight. It is not a device-independent performance budget.

In the instrumented capture (milliseconds relative to the map jump):

| Stage | Start | Duration |
| --- | ---: | ---: |
| GTFS initialization | 697 | 18,900 |
| GTFS synchronization | 1,183 | 18,122 |
| Catalog decode worker created | 1,858 | 309 to first message |
| GTFS display-table write transaction | 2,321 | **16,336** |
| Compressed bundle write | 19,053 | 23 |
| Stop-group write | 19,079 | 226 |

The large transaction spans routes, trips, services, stops, shapes and sync
metadata. The instrumentation measures transaction creation through completion,
including queued time; it does not isolate each table's disk cost. Main-thread
CPU profiling does not account for most of the elapsed time as JS computation.
An earlier unprofiled run showed 37 cards at about 0.75 s, then badge/filter
changes around 17.8 s and a further reduction to 33 cards around 18.3 s.
Another run had not completed GTFS initialization within the 25 s capture window.

Source chain:

- `hooks/useCityGtfsLifecycle.ts`: city switch waits for `reset()`, then `init()`.
- `stores/cityStore.ts`: evicts the previous city's raw PTB bytes and catalog.
- `stores/gtfsDataStore.ts:459`: reset clears GTFS tables before clearing resident state.
- `services/gtfsSync.ts:271`: synchronously awaits full display-table persistence,
  compressed JSON catalog persistence, and stop-group construction.
- `stores/gtfsDataStore.ts:393`: only after sync finishes does it build/install the
  JS index and clear `syncing`; urban filtering then becomes authoritative.

Thus revisiting a city ordinarily repeats expensive work even after that city was
used earlier. Explicit offline city packages have a separate restoration path.

### 2. Badge loading deliberately changes displayed truth several times

`hooks/useVisibleStops.ts` has two gates: missing index or `syncing` bypasses both
urban-filter stages. Once ready, per-stop tile state determines badges:

| State | Display |
| --- | --- |
| No index, or syncing | All cached lines and stops |
| Index ready, no tile entry | All cached lines |
| Tile loading | **Empty lines: name-only card** |
| Tile unavailable | All cached lines |
| Tile ready | Only active routes |
| Index says inactive | Stop removed |
| Tile ready and empty, index cannot decide | Stop removed |

The added characterization test reproduces full → empty → full → narrowed →
hidden as these independent states change. It demonstrates that the code permits
this sequence; it does not establish that every browser run follows that exact
ordering. Existing tests already explicitly expect the name-only loading policy.

`useViewportBadgeActivity` evicts entries outside each buffered viewport, marks
new entries loading, resolves stops sequentially, and publishes the final batch
only when every stop settles. This makes the initial blank-badge period depend
on the entire sweep. Panning back to evicted stops repeats loading. The decoded
tile cache has only two slots and no in-flight deduplication; the live capture
also contains duplicate requests for the same Krakow schedule tile.

### 3. Filtering also triggers expensive placement work

Every visible-stop array change reaches `TransitMap`'s source update and marker
solver. Badge membership is part of `stopSetKey`, so badge changes also clear and
rebuild road hints, followed by another solve. A change in badges changes card
size and placement priority; some later card disappearance can therefore be
collision placement rather than an inactive-stop verdict.

At card zoom, each marker update scans city stops, measures uncached cards,
solves collisions, and renders separate React roots. The solver has nested
candidate/placed-card/dot scans. These are plausible contributors to panning
sluggishness, but this investigation did not obtain a representative GPU pan
trace; software-WebGL timings must not be used to claim normal frame rates.

At lower zoom there is a concrete post-staging difference: public hosting changes
removed clustering and draw individual stops from overview zoom. The older
staging source uses clustering through zoom 12. This increases the number of
visible points, but its contribution to the reported sluggishness remains unmeasured.

## Production versus staging and pre-public source

The user-opened staging tab in Zen displays **v0.1.0 · 2b689924 ·
2026-11-03 14:33 UTC**. That revision exists as `2b6899246` in the archived repo.
Against production `005932ef`:

- City GTFS lifecycle, city store, viewport badge activity, PTB catalog decoder,
  worker client and schedule tile cache are byte-identical.
- `useVisibleStops` differs only in comments.
- Full display-table persistence and compressed bundle encoding are unchanged.
- GTFS sync adds the explicit `requireNetwork` option; the normal map-switch
  caller does not request it.

Consequently, no new badge-policy regression between those revisions is proven.
Feed contents/volume, browser storage, caching, and deployment behavior remain
candidate explanations for why the existing mechanism is more visible now.

Fresh staging HTTP/browser probes returned a Zoraxy “521 - Web server is down”
HTML page (HTTP status 200), including for the version API. The existing Zen
session displayed a working application but Settings reported `Backend —`.
A separate API navigation in Zen showed a blank PTN document rather than JSON.
This is consistent with a cached application shell and does not establish a
healthy staging backend. No service worker/cache was cleared. A matched fresh
staging network/data comparison remains unavailable, so relative speed claims
would be premature.

## Causal chain and next changes to evaluate

1. Why do lines disappear? Loading explicitly strips lines; ready urban data
   later removes inactive routes/stops.
2. Why do they reappear? Syncing/unavailable/no-entry paths expose full lines.
3. Why does final filtering arrive late? It waits for index installation after
   the full catalog persistence pipeline.
4. Why does every switch pay that cost? Active-city data is cleared/evicted and
   the planner/index readiness path is coupled to persistence.
5. Why is this perceived as several unstable renders? Separate stop, index,
   tile and placement lifecycles publish independently, without one city-scoped
   display readiness policy.

Recommended order for a follow-up fix:

1. Decouple usable in-memory timetable/index readiness from the slow display-table
   persistence transaction, preserving atomic offline recovery and city guards.
2. Define one display transition policy; avoid clearing already displayed badges
   merely because activity is unresolved, while making pending data explicit.
3. Scope manifest/activity state by city and generation. Current manifest cache
   and badge keys are not city-scoped; badge effect dependencies include timezone
   but not city ID. This is a separate correctness risk, not a proven cause of
   this capture's delay.
4. Group tile work, deduplicate concurrent tile reads, and avoid rebuilding road
   hints from transient badge filtering. Profile actual GPU panning separately.

## Evidence and validation

- `production-capture.json`: selected worker/transaction events, performance
  measures, API timings, card snapshots and long tasks from one instrumented run.
- `scripts/diagnostics/city-switch.cjs`: isolated probe. Requires installed
  Playwright Chromium; writes raw captures under `/tmp/ptn-perf` (override with
  `PTN_PERF_OUTPUT`). Defaults to a local DEV build at `http://localhost:5173`
  and uses the supported `__ptnMap` hook. Pass an origin as the first argument,
  `--arrival-only` for the original jump probe, or `--gpu` for a headed browser
  with normal GPU selection. Actual hardware acceleration still needs verification
  in the recorded browser. Historical deployed builds require explicit
  `--legacy-react-probe` to use the original React-ref fallback. Animated runs
  mark both flight start and arrival. Local stage measures include city identity,
  elapsed time and completion/failure; they send no telemetry. The probe does not
  modify deployed JS or a user's browser profile.

Candidate artifact-path replay is summarized in
`candidate-artifact-summary.json`. The isolated headed Chromium renderer was
confirmed as ANGLE Metal on Apple M4 Pro. Krakow catalog fetch/decode/index took
591/410/118 ms; index installation preceded the 61 ms artifact publication.
There was no bulk trip projection write (the recorded legacy-table transaction
was reset cleanup). This live-feed desktop observation is not a controlled
speedup ratio against the earlier software-WebGL production capture, nor a
mobile or retained-city scaling result. React nested-root unmount warnings
found during the first candidate replay were absent after deferred disposal.

For local Vite against the deployed multi-city API, pass
`--api-origin=https://ptn.uerban.org`: the ordinary development proxy targets a
single-city backend and strips `/api/<city>`. The diagnostic override preserves
the deployed paths. Probe failures retain console/network/stage evidence in
`failure.json`; successful captures include the renderer and stage city details.

Controlled API replay results are in `fixed-feed-matrix.json`. Both local builds
used identical response bodies, a fixed Date wall clock, the same serialized
legacy archive template and the same Apple M4 Pro Metal renderer. Service
workers were blocked so no API request could bypass interception; all six runs
had zero fixture misses. There was one run per cell, not a statistical sample.

| Retained legacy packages | Base arrival → index ready | Candidate arrival → index ready | Base list discovery | Candidate list discovery |
| --- | ---: | ---: | ---: | ---: |
| 0 | 17.95 s | 1.40 s | 0.2 ms | 4.2 ms |
| 1 | 18.54 s | 1.40 s | 17.6 ms | 0.9 ms |
| 8 | 18.61 s | 1.30 s | 157.9 ms | 0.4 ms |

The base's six-table projection transaction took 15.73–16.04 seconds; none
occurred in candidate activation. Four-direction all-stops pans at zoom 16 had
p95 frame intervals of 17.3–17.6 ms across both versions. This desktop scenario
does not reproduce a pan regression, and does not establish mobile performance.
The slow base activation at zero archives also rules out retained-city count as
a necessary cause of this reproduced delay. Base replay captured its erroneous
Krakow tile request under Vilnius's manifest hash; the frozen response is the
server's actual 409, rather than an invented success.

To reproduce, record with `--record-api=/tmp/<dataset>` plus the deployed API
origin, then use `--replay-api=/tmp/<dataset> --retained=0` (or 1/8) and `--pan`.
The fixture folder contains timetable data and a serialized archive template;
keep it outside the repository. The first template is reused verbatim across
versions. Replay fails if a request has no recorded response. Freeze only Date:
Playwright's full clock replacement also replaces Performance APIs and cannot
be used for this probe. Other external map resources remain live, so these are
controlled API/CPU-readiness observations rather than a fully hermetic render
benchmark.
- `tests/hooks/useVisibleStops.test.ts`: added lifecycle-sequence characterization.
- Validation: `vitest run --root packages/frontend
  tests/hooks/useVisibleStops.test.ts tests/hooks/useViewportBadgeActivity.test.ts`:
  **2 files, 23 tests passed**. At that early checkpoint dependencies were linked from the existing checkout.
  The implementation now has separately installed worktree dependencies.

## Follow-up: could retaining multiple cities have introduced it?

Inspected feature `2d801f6` and download repair `31107c0` in response to that
hypothesis. This feature has additional costs, but populated retained packages
are not required for the measured failure: the production captures used new
browser contexts, with no prior downloaded cities or user profile.

The normal online map switch calls `init(cityId)` without `preferDownload`.
When synchronization succeeds it does **not** invoke `restoreDeviceCity` or
`saveDeviceCity`. The measured 16.3 s transaction included only the six ordinary
GTFS tables, not `offlineCities` or `offlineTransfers`. The feature did not
change that display-table write loop. A new characterization test configures a
restorable package and confirms ordinary online init still uses synchronization
without calling package restoration. This is control-flow evidence, not an
A/B performance comparison of the entire feature.

Costs introduced by the feature that do warrant separate attention:

- `saveDeviceCity` copies nine live tables, plus raw PTB and compressed catalog,
  into a single large package row. It also JSON-stringifies table contents to
  estimate size. Its read/write transaction includes the live tables and can
  block overlapping work while an explicit download is saving.
- `restoreDeviceCity` clears and bulk-writes the selected package back into the
  same live tables. Restoration is not a cheap in-memory pointer swap; it can
  reproduce substantial persistence costs when offline, explicitly opening a
  download, or falling back after an online error.
- `listDeviceCities()` uses `offlineCities.toArray()`, cloning **all package
  contents** merely to list names/metadata. `chooseInitialCity` calls it before
  its online saved-city early return, and the Settings download section calls it
  when mounted/refreshed. This can make startup/Settings scale poorly with
  retained city count, but it is not called on each ordinary map pan/city switch.
- Transfers are now retained and verified through `offlineTransfers`, adding a
  read/hash and sometimes a write. In the instrumented switch that write took
  approximately 1 ms, after the large GTFS transaction had already completed.
- An online map switch does not prefer an already downloaded package, so saved
  cities do not automatically avoid the normal network-and-persistence cost.

Conclusion: retaining multiple cities is a credible contributor in download,
restore, startup and storage-pressure scenarios. It is not established as the
cause of the ordinary online-switch delay captured here. A same-feed pre-feature
versus post-feature browser benchmark, plus a populated-package case, is still
needed to separate schema/storage effects from the existing synchronization cost.

Follow-up validation: GTFS lifecycle, device-city storage and Settings download
suites: **3 files, 29 tests passed** (includes the new ordinary-online-init test).
