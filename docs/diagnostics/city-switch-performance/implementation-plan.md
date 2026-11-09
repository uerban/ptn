# Fix city ownership, activation, offline storage, and map performance

This is the accepted implementation plan. Checkboxes preserve its requirements;
current completion and open gates are tracked in the [completion audit](completion-audit.md)
and [implementation review](implementation-review.md).

Worktree: `ptn-perf-investigation`; branch: `investigate/city-switch-performance`.
Base branch: `rework/transit-packs-v0.1.3` in every affected repository.
Keep this work in separate worktrees and aggregate it into that branch's existing
PRs later; do not target `main` independently. The product investigation is based
on `e4420d9`. Revalidate implementation assumptions against the transit-pack
contracts on this base; the deployed-version captures below remain historical
evidence, not measurements of the rework branch. Any feed or platform repository
that needs changes must use the same base branch before work starts.
Evidence: [city-switch investigation](README.md).

## Outcome

Switching cities should activate one coherent city dataset promptly, reuse local
artifacts, and settle urban stop labels without full → empty → full badge churn.
Retaining more offline cities must not make ordinary startup deserialize all
those cities. Panning should preserve the all-stops view without repeatedly
rebuilding city data, tile decodes, and label geometry. Each city also retains
its own saved places and transport preferences, while personal app-wide settings
remain global.

Keep offline downloads, all-stop dots, urban-mode service semantics, walking
transfers, on-device routing, and existing user data. Do not solve this by
removing multi-city support, clearing user caches, silently deleting downloads,
or restoring clustering as a performance shortcut. No PTB wire-format or routing
algorithm change is part of this plan.

## Approach and decisions

Recommended: staged storage/lifecycle repair, followed by display and rendering
work. A flicker-only patch leaves the measured 16.3 s persistence dependency
intact. A single storage rewrite makes migration and regression diagnosis harder.

Use city/generation identity throughout the data path. Keep metadata separate
from large artifact payloads. Activate verified local data before waiting for
optional persistence, and revalidate online in the background. Publish a new
city/generation coherently; keep persistence and refresh status separate from
whether the active map/planner can be used.

Confirmed display policy: show stop dots/names immediately on first entry; reveal
urban badges when activity resolves. Retain valid resolved badges during refresh
and revisits. When a rendered stop becomes inactive within the urban time limit,
fade its visible dot/name/card before removing it. Remove offscreen stops
immediately. Pending activity is not an authoritative empty result; another
city's data is never retained for continuity.

### Ownership model: current city is a reference

`currentCityId` selects an independently stored city; it is not a destination
into which all other cities' data is copied. Resolve display configuration from
the city catalog instead of persisting a second mutable CityConfig snapshot.
An activation epoch and data generation belong to the runtime context, not the
identity of the user's city profile.

| Owner | Data | Lifetime |
| --- | --- | --- |
| App/device | Language, light/dark/system theme, accessibility/high contrast/reduced motion, mobility and walking defaults, privacy/storage/GPS permissions, notifications, credentials, disabled transport modes, general UI defaults | Independent of city |
| City user profile | Saved places/favorites and their order, excluded route groups, transport palette/colour overrides, permitted remembered viewport | Survives feed refresh and download removal |
| City data generation | Verified PTB, transfer/shape references, stops/routes/trip lookup and derived projections | Versioned and replaceable without changing user profile |
| Runtime city context | Active index/planner, viewport activity, requests, animation and presentation state | Active epoch; bounded warm caches only |

Disabled transport modes, urban-mode settings, lookahead and map-detail preference
stay global in this iteration. Add an explicit city override only for a demonstrated need. City
transport colours must respect global accessibility requirements; changing cities
must not turn off high contrast, alter mobility needs, or weaken privacy policy.

Prefer logical city partitions in the existing IndexedDB database, with explicit
city/generation keys and city-indexed queries. A separate physical database per
city adds migration/connection coordination without making context-less reads
safe; one giant object per city recreates the package-deserialization problem.
Use separate lightweight profile/settings rows, individually queryable user-data
rows, and separately addressable large artifacts. Shared immutable blobs can be
referenced from several cities without duplicating their bytes.

## 1. Establish a reproducible baseline

- [ ] Extend the diagnostic probe with supported test hooks rather than React
  fiber traversal. Record actual city flights as well as arrival-only activation.
- [ ] Pin identical feed/artifact bytes for the pre-feature source, deployed
  source, and fixes. Replay those inputs locally; do not compare different feed
  snapshots and call the result a code regression.
- [ ] Record zero, one, and eight retained-city cases; distinguish ordinary online
  switching, explicit downloaded-city opening, offline fallback and cold startup.
- [ ] Add marks for cache lookup, fetch, decode, individual GTFS write stages,
  transaction queue/complete, index ready, planner ready, first stable badges,
  durable download ready, and placement work. Include cancellation and failure.
- [ ] Capture real GPU pan traces separately from software-WebGL data-readiness
  probes. Cover low zoom, label zoom and card zoom, with urban mode on/off.

Deliverable: bounded evidence and a comparison table for Vilnius, Krakow, and
one large city (Oslo or Warsaw), then functional coverage across all eight.
Record browser, hardware, viewport and cache state. Keep measurements local;
no new server telemetry containing stop selection or precise location.

Acceptance: one command reproduces the slow path and attributes the elapsed
cost. Separate observations from proposed release budgets.

## 2. Make city metadata cheap and protect downloaded data

Primary files: `services/deviceCities.ts`, `setup/startupGate.ts` (formerly
`chooseInitialCity.ts`),
`components/Settings/DeviceCitiesSection.tsx`, `db/index.ts`,
`db/dataSchemaVersion.ts`, migration and storage-policy modules.

- [ ] Introduce lightweight city-package metadata: city ID, retained/downloaded
  status, generation, artifact references, byte sizes, prepared time and
  completeness. Store large payloads separately by city/generation/artifact key;
  shared transfer blobs remain content-addressed.
- [ ] Replace list operations that read `offlineCities.toArray()` payloads with
  metadata-only reads. Startup and Settings must not deserialize other cities.
- [ ] Remove JSON serialization merely to estimate package size; derive sizes
  from serialized artifact bytes and maintained projection accounting.
- [ ] Reuse immutable artifacts when marking an already cached generation as an
  explicit download. Saving it should update references/metadata, not snapshot
  every live GTFS table again.
- [ ] Define cache eviction separately from retained downloads. Ordinary cached
  generations use a bounded disk budget; explicitly downloaded cities are pinned
  against routine eviction. Removing a download removes its pin/reference, with
  shared artifacts collected only when no committed package needs them.
- [ ] Migrate existing giant package rows lazily, one requested city at a time.
  Discover legacy city IDs with key-only reads and create lightweight legacy
  placeholders; defer unknown size/details until that city is accessed. Do not
  scan package values at startup to backfill metadata. Retain each legacy
  package until its replacement is
  complete and verified. No network requirement for legacy offline recovery.
- [ ] Audit the generic server-derived data-schema wipe: it currently includes
  offline city packages. A schema bump for this repair must migrate supported
  downloads rather than silently wiping them. Preserve user-owned stores.

Acceptance: metadata listing reads zero artifact payloads and its transferred
bytes scale with city count, not timetable size. Failed/interrupted migration
leaves the previous offline city usable. Removal preserves shared transfers.

## 2a. Partition saved places and transport preferences by city

Primary files: `stores/cityStore.ts`, `stores/settingsStore.ts`,
`stores/favoritesStore.ts`, `components/Favorites/FavoritesBar.tsx`,
`services/favoritesMigration.ts`, saved/recent endpoint read/write paths,
`utils/mapViewport.ts`, `db/index.ts`, and Settings/search consumers.

Current evidence: transport colour overrides and route-group exclusions already
have city keys; `excludedModes` is global and will remain so. Legacy favorites filter only stop
favorites by city, so home/work/place entries appear everywhere. The newer saved
locations bar reads the whole table without a city constraint; its row schema
has no city ownership field. The legacy-to-saved migration also drops the legacy
favorite's city association. Reuse existing per-city information where present.

- [ ] Define typed app-wide defaults and a separate city transport-preference
  record. New city profiles start from explicit defaults; changing city A never
  mutates city B or the global defaults. Avoid parallel mutable copies of one
  effective setting in both global and current-city stores.
- [ ] Keep disabled transport modes in the global settings store, with no
  per-city copies or exclusion-list migration. Retain existing city-keyed colour
  overrides and route-group exclusions. Resolve city-specific default exclusions
  as an effective policy for that city, without mutating the persisted global
  user selection; explicit user choices take precedence. Test city switching and
  default seeding so one city's defaults do not leak into another.
- [ ] Require a city scope on newly saved places/favorites, including home/work
  and coordinate-only places. Query by current city before materialization or
  decryption. Preserve record identity, aliases, timestamps, colours, encryption,
  and per-city order. Reordering/deleting A's list cannot drop B's entries.
- [ ] Make route-pair ownership explicit. A save normally belongs to the city in
  which it was created; if the UI supports a cross-city pair, preserve both
  endpoint identities and explicit memberships rather than guessing from whichever
  city happens to be current when the record is read.
- [ ] Scope route/search recents and city stop-usage ranking by captured city
  context where those histories are enabled, preserving existing TTL/storage
  policy. Never key cross-city usage by bare stop ID. If any history is intended
  to remain global, expose it separately rather than mixing it into city results.
- [ ] Store the last permitted viewport per city instead of one last viewport
  for the whole app. Continue to enforce the global precision/persistence policy;
  reducing permission sanitizes or removes all affected city viewports.
- [ ] Select the new city's profile, saved-place query and effective transport
  settings coherently when `currentCityId` changes. Pending hydration shows that
  city's loading state, not the prior city's favorites/preferences. Async setting
  writes capture the intended city ID at the action boundary.
- [ ] Label Settings sections as app-wide versus current-city. Keep reset actions
  scoped; removing downloaded timetable bytes must not delete places or transport
  preferences. Cities temporarily absent from discovery retain their user profile.

Migration rules:

- [ ] Preserve existing explicit city IDs and the `gdansk` → `tricity` alias.
  Do not stamp every unscoped legacy favorite with the currently selected city.
- [ ] For unscoped legacy saves, use existing provenance or unambiguous local
  geographic evidence. Preserve uncertain records in an unassigned recovery view
  for user assignment; never drop them or duplicate them across every city.
  No server lookup of private saved coordinates is needed.
- [ ] Preserve encryption and RAM-only behavior across scope migration; do not
  place endpoint coordinates or aliases in partition/index keys. Validate migration
  of encrypted places, aliases, route pairs, and unavailable city catalogs.
- [ ] Preserve existing city colour/group maps directly and leave persisted
  global transport exclusions intact. Do not infer per-city mode preferences
  from the historical global array or reset that array during profile migration.
- [ ] Version and make the migration resumable/idempotent. User profile/saved-place
  stores are user-owned and cannot be removed by feed-cache schema wipes, refresh,
  ordinary eviction, or download removal. Any compatibility reads must remain
  city-filtered until the last legacy writer is retired.

Acceptance: a regular visitor has independent Home/Work lists, route-group
exclusions, route colours and map positions in A and B. A → B → A restores them, offline and
after reload; disabled transport modes, language, theme, privacy and mobility
stay unchanged. Changing the global disabled-mode selection applies in every city. Feed generation
replacement and removing a city download preserve its user profile. Listing A's
places reads/decrypts no B payloads. Partial migration and ambiguous legacy scope
lose no records. Existing favorites reorder/migration paths have regression tests.

## 3. Introduce a coherent city data context

Primary files: `stores/gtfsDataStore.ts`, `stores/cityStore.ts`,
`hooks/useCityGtfsLifecycle.ts`, `services/gtfsSync.ts`, `services/raptorIndex.ts`,
`services/wasmLifecycle.ts`, and consumers listed below.

- [ ] Persist only the selected city reference; bind user-profile readers to
  city identity and feed readers to city plus generation. Do not copy B into
  global “current city” tables on selection.
- [ ] Define an activation token `{cityId, generationId, activationEpoch}` plus an
  abort signal. All async reads/results, tile activity, index/planner installs
  and persistence jobs carry or validate that context.
- [ ] Separate active-city readiness from network refresh and durable-download
  readiness. `syncing` must no longer turn valid current-city urban data into
  unrestricted full lines during background work.
- [ ] Invalidate old-city handles synchronously when a switch begins. Abort
  obsolete requests/builds; free obsolete planner handles at their safe lifecycle
  boundary. Do not wait for an IndexedDB clear before changing memory state.
- [ ] Introduce city-aware read access before moving writes into the background.
  Audit all direct reads of unscoped GTFS tables. Cover stop coordinates/groups,
  search, route patterns, corridor/shape rendering, leg geometry, navigation,
  arrive-by displays, and planner construction.
- [ ] Serve these reads from the verified active catalog/index or explicitly
  city/generation-scoped projections. A reader captured for A must never consume
  B's rows after an await. Reactive stop-group queries must follow activation.
- [ ] During the transition, any remaining legacy active-table consumer requires
  a matching projection-ready generation. Never start a background writer to
  shared unscoped tables and assume an epoch guard after completion makes it safe.

Acceptance: rapid A → B → A, overlapping refresh, shared stop/route IDs, same-timezone
cities, and delayed A responses cannot install data or statuses into B. Every
consumer either returns matching-city data or a pending/unavailable result.

## 4. Remove persistence from the activation critical path

Depends on the context/read seam in step 3 and artifact model in step 2.

- [ ] Prefer a compatible verified local generation on ordinary online switches,
  including downloaded cities. Revalidate asynchronously. Explicit Update still
  requires a network result and reports failure honestly.
- [ ] On a cold load, decode once in a worker and reuse that result to construct
  the active index and compact display lookup. Avoid decode → write full tables
  → gzip JSON → reread/gunzip JSON merely to activate the same dataset.
- [ ] Start the WASM planner from the same verified PTB bytes/provenance; preserve
  transfer attachment and existing engine ownership semantics.
- [ ] Commit one coherent in-memory city snapshot when required map data is
  ready. Optional shapes and durable writes may complete later without resetting
  stop/badge readiness. Publish planner readiness separately and explicitly.
- [ ] Persist immutable per-generation artifacts and only necessary derived
  projections. Stop eagerly materializing full trip rows if audited consumers
  can read them by ID from the resident catalog. Keep compatibility projections
  only until their callers are migrated; track their removal explicitly.
- [ ] Use bounded write jobs; stage payloads outside short metadata transactions.
  Flip a package's committed pointer only after all required artifacts are
  durable. Abort obsolete activation work; safe immutable cache writes may
  finish without changing the active city.
- [ ] Preserve the last complete disk generation through refresh failure,
  interruption and quota exhaustion. Distinguish usable-online from saved-offline;
  never report a completed download before required bytes are durable.
- [ ] Bound memory: one active decoded city, bounded optional warm data, no
  decoded copies of all saved cities. Release canceled decode/planner results.

Acceptance: no full display-table rewrite on a warm city switch; no index-ready
wait on optional persistence. Inject a 20 s persistence stall and verify that
online map/planner activation proceeds, then verify offline recovery after reload
uses only the last committed complete generation.

## 5. Stabilize urban badges and share tile work

Primary files: `hooks/useVisibleStops.ts`, `hooks/useViewportBadgeActivity.ts`,
`stores/badgeActivityStore.ts`, `services/scheduleTileReadPath.ts`,
`services/scheduleTileCache.ts`, `services/scheduleTilePrewarm.ts`.

- [ ] Key manifest, activity, requests and retained verdicts by city/generation;
  activity validity also includes time window/lookahead. Add city ID to lifecycle
  dependencies; timezone equality must not suppress a city switch.
- [ ] Represent pending, resolved-empty and unavailable distinctly. Pending or
  refresh must not clear valid badges, and failure must not resurrect all routes
  after a valid narrower verdict. Apply the confirmed first-entry display policy.
- [ ] Batch stop visibility and route activity updates from one context/window.
  Preserve authoritative index semantics and the uncovered-stop fallback. Do not
  invent an index badge shortcut that disagrees with schedule-tile departures.
- [ ] Group viewport stops by owning tile, fetch/decode once, and compute their
  activity together. Bound tile concurrency and deduplicate in-flight work across
  badges, prewarming and departure reads. Cancellation detaches one consumer
  without canceling another consumer's shared request.
- [ ] Retain nearby/recent verdicts in a bounded cache instead of evicting every
  stop just outside the current viewport. Use bounded byte-aware decoded caching
  where justified by measurements; do not replace LRU(2) with unbounded retention.
- [ ] Make generation pruning city-aware so opening B does not invalidate A's
  retained tiles. Publish tile-level batches so one slow tile does not hold all
  unrelated resolved badges hostage.

Acceptance: no full → empty → full transition caused only by loaders; unchanged
viewports and small out/back pans do not refetch/redecode the same valid tile.
Inactive routes/stops still disappear when a resolved current window proves it,
and scheduled minute changes remain correct.

### Inactive-stop fade contract

- [ ] Maintain exiting stops only in map presentation state, keyed by city and
  generation. Authoritative visible-stop/activity results remove them immediately
  from interactions and downstream proximity/routing consumers.
- [ ] At the inactive verdict, use the actual viewport, not the preload buffer:
  a visible dot or intersecting label/card fades; wholly offscreen representations
  are removed immediately. Proposed duration: 200 ms, using one shared setting
  for dot, symbol label, connector and DOM card. Respect reduced-motion settings.
- [ ] Keep the exiting stop's last rendered geometry/content through the fade;
  remove its presentation feature/marker on completion. Avoid a badge-clearing
  render before fading and avoid an abrupt card collision re-solve mid-fade.
- [ ] Use a bounded shared animation scheduler/paint updates, not a React render,
  full-city source rewrite or road-hint rebuild per animation frame. Compose exit
  opacity with the existing dimmed-dot state.
- [ ] If the stop becomes active before completion, cancel its exit and restore
  the current appearance without remounting. If it moves offscreen during exit,
  drop it immediately; moving back must not restart an expired fade.
- [ ] City/generation replacement cancels old exits and removes old-city visuals;
  no ghost markers survive the switch. Unknown/pending status alone never starts
  an inactivity fade. Ordinary collision hiding is a separate placement rule.

Acceptance: deterministic browser tests cover on-screen fade, buffered-but-offscreen
immediate removal, pan during exit, reactivation, reduced motion, and city switch.
The stop stops responding to clicks as soon as its authoritative verdict is
inactive. Dot, name, badges and connector fade together without per-frame source
rebuilds. No inactive stop reappears because a tile request becomes pending.

## 6. Reduce map placement and redraw work

Primary files: `components/Map/TransitMap.tsx`, `cardPlacement.ts`, `StopMarker.tsx`,
road-hint derivation and viewport stores.

- [ ] Split geometry identity from displayed badge membership. Derive road hints
  from stable city/generation route geometry, not a transient filtered badge list.
- [ ] Rebuild the stop GeoJSON source only when geometry or source properties
  change; badge-only updates must not reserialize all city points.
- [ ] Add a per-generation spatial lookup for viewport candidates. Avoid scanning
  the complete city on each pan, and reuse membership-stable candidate sets.
- [ ] Coalesce data, viewport, obstacle and hint invalidations into one scheduled
  placement pass. Avoid repeated initial solves and a full rerender for unchanged
  marker props; measure once per actual dimensions/font change.
- [ ] Profile candidate scoring. If it dominates, spatially index card/dot
  collision tests, preserve selected-stop priority and placement hysteresis, and
  update only affected markers. Keep geometry and visibility rules testable.
- [ ] Keep all stop dots available at intended zoom levels. Measure lower-zoom
  unclustered rendering independently; use efficient source/layer handling rather
  than silently reducing stop coverage. Change marker technology only if traces
  show remaining DOM/React-root overhead justifies that larger step.

Acceptance: badge-only changes trigger no road-hint reload or geometry-source
rewrite; one viewport settle triggers one intended placement pass. Cover dense
and sparse views, overlays, selection, zoom bands, fonts and theme changes.

## 7. Validation, budgets, and release

Test scenarios (small deterministic unit fixtures plus real browser captures):

| Area | Required cases |
| --- | --- |
| City user data | Independent favorites/order, route-group exclusions, colours, viewports; disabled modes remain global; ambiguous/encrypted legacy saves; download removal preserves profile |
| City activation | Cold city; warm A → B → A; fast switching; delayed old-city result; identical stop IDs/timezones |
| Storage | 0/1/8 downloads; legacy migration; explicit save/open/update/remove; reload offline; quota failure; interrupted write |
| Generation | Failed refresh preserves old generation; successful replacement is coherent; shared transfer references |
| Urban display | First entry pending; tile unavailable; current resolved-empty; inactive index; minute/lookahead changes; generation skew |
| Fade | Visible stop; outside actual viewport; pan out/back; reactivation; reduced motion; city replacement |
| Map | All stops; dense cards; low zoom; urban on/off; overlays; selected stop; themes/fonts; road hints |
| Planner consumers | Route search; schedule mode; line preview; route-leg geometry; guidance; arrive-by surfaces |
| Lifecycle | Service-worker upgrade; old open tab during DB upgrade; resume; network loss; cancellation; memory release |

- [ ] Run targeted tests with each change, then frontend typecheck/lint/build,
  existing offline/privacy/engine cold-start checks and affected route/geometry
  suites. Preserve routing golden behavior; no golden changes expected.
- [ ] Compare fixed snapshots against pre-feature, deployed and candidate code.
  Report p50/p95 plus worst observed activation and stable-label times, transaction
  costs, network counts, decode counts, heap/retained artifact sizes and pan frames.
- [ ] Validate Chromium and WebKit on a fixed reference machine. Record actual
  mobile-device traces when available; emulation and software WebGL are not proof
  of phone GPU performance.
- [ ] Set checked-in timing budgets from step 1, before accepting the performance
  changes. Proposed targets below must be calibrated to the recorded hardware;
  structural and correctness gates are mandatory regardless of machine speed.

Proposed acceptance targets:

- Warm verified-city activation and stable urban labels: p95 ≤ 1 s after arrival
  on the reference desktop, with no full-table rewrite or required network roundtrip.
- Cold activation: p95 ≤ 2 s of local work after required bytes arrive. A deliberately
  stalled optional write must add zero dependency to in-memory readiness.
- Download metadata: no payload reads; eight-city metadata lookup adds ≤ 50 ms
  p95 versus an empty list on the reference machine.
- Tile sharing: one in-flight fetch/decode per city/generation/tile key; no
  decode on unchanged-view warm refresh and no duplicate prewarm/badge downloads.
- Fade: 200 ms nominal duration; no delayed offscreen removal, cross-city ghosts,
  or interaction with an authoritatively inactive stop.
- Panning: aim for p95 frame intervals ≤ 20 ms on the chosen reference GPU and
  no map-update task > 50 ms in the representative route. If baseline workload
  makes that unsuitable, record and review the replacement budget before release;
  do not hide stops to meet it.
- Memory: active decoded data is bounded; repeated A/B switches reach a plateau,
  with no retained canceled planners or decoded packages for all stored cities.
- Offline correctness: every completed explicit download survives reload without
  network; failed updates/migrations leave the previous complete city usable.

Release sequence: local replay and browser checks → reviewable focused PRs →
validated staging candidate → production promotion through the existing manual
release process. Prepare concrete artifacts and evidence before requesting any
approval needed for publishing/deployment. This plan does not authorize those
remote actions. For storage rollback, first releases are additive and retain
legacy package data until conversion is verified; verify compatibility with the
prior reader rather than assuming application rollback reverses a DB migration.

## Suggested implementation slices and dependencies

1. **Measurements and metadata listing:** step 1, metadata-only list/store,
   preservation-aware migration scaffolding from step 2. Small reviewable changes;
   no city activation behavior change yet.
2. **City ownership, context and reader migration:** steps 2a and 3. Enumerate direct table consumers
   in the PR checklist; make generation mismatches explicit. This is the safety
   prerequisite for asynchronous persistence. Include saved-place and preference
   migration so the current-city reference consistently selects both data and
   user state.
3. **Artifact reuse and fast activation:** finish step 2 and implement step 4.
   Retain migration/compatibility tests; prove the stalled-write case.
4. **Urban activity and fade:** step 5, including city-aware tile state, bounded
   shared work and the confirmed fade behavior. Replace the investigation's
   characterization of bad transitions with the desired behavioral assertions.
5. **Map work reduction:** step 6. Use traces to decide how much solver/marker
   restructuring is justified; keep all-stop coverage.
6. **Cross-browser regression and rollout evidence:** step 7 across the complete
   stack. Recheck all eight cities and retained-download upgrades.

Each slice records what changed, relevant timings, correctness checks and known
limits. Do not mark the campaign complete merely because flicker is masked: warm
activation, metadata scaling, durable offline recovery and map responsiveness all
have separate acceptance gates.
