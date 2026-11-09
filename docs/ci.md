# CI and release gates

Routine checks and release preparation have different costs and purposes.

| Workflow | Trigger | Required work |
| --- | --- | --- |
| **CI** | Pull requests, pushes to main, manual | Classify changed paths; build/test source and smoke-test all five native platforms when needed |
| **Regression gates** | Manual exact-commit run; PR with `ci:regression` label | Performance, memory safeguards, WASM and PTB parity budgets |
| **Release candidate validation** | Pushes to main; manual exact-commit run, including dispatch by release preparation | Build all installable platforms, validate native/Docker fresh-host lifecycle and retain archives |
| **Draft release from validated artifacts** | RC tag or manual existing RC tag | Require matching regression evidence and validated archives before creating an RC draft |
| **Promote immutable RC to stable draft** | Manual on main | Copy the published RC assets and proof unchanged; no builds |

## Routine CI

README files, root prose and Markdown under `docs/` or `.github/` do not compile
the application. Unknown paths, executable examples, JSON budget/config changes,
workflow changes, mixed code/documentation changes and manual CI runs take the
source path. Deletions and both sides of renames count; push classification covers
all commits since the previous push. The workflow compares local Git history,
so it does not depend on the Actions path-filter file limit.

The **CI** result job always runs. It accepts a deliberate prose-only skip and
fails on classification failures, failed security scans or failed/cancelled source jobs. Use that single
status for branch protection; do not require optional regression or platform jobs.
A workflow skipped by a top-level path filter can leave required checks pending;
this design uses job conditions instead. See the
[GitHub workflow-trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

Source CI retains workspace builds/tests, typechecks and lint. In parallel, its
native platform matrix builds all six tools for Linux x86_64 musl, ARMv6 hard-float,
AArch64, macOS Apple Silicon and macOS Intel. It verifies the binary format and
architecture, runs CLI smoke checks and builds a tiny walking graph. Linux ARM
checks execute through QEMU; ARMv6 also checks trusted local TLS and hard-float
attributes. These checks use cached Rust dependencies and pinned Linux compilers.
The required **CI** aggregate rejects any failed/cancelled platform check; a
prose-only change deliberately skips both source and platform builds.

Routine checks do not fetch reference-city OSM/GTFS inputs, package release
archives or run deployment lifecycle checks. Those remain mandatory during
release candidate validation. Routine platform outputs cannot be promoted as
release assets; RC archives are built/validated once and later copied unchanged
during stable promotion.

## Run regressions when needed

Each run publishes a human-readable job summary with the exact source revision,
overall result and every gate/prerequisite outcome, including failures and skips.
The summary and `regression.json` also list each measured value with its budget
(WASM and bundle sizes, index p99, JS heap, cold-start p95 stages, city-switch
and pan timings). Routing parity and native RSS checks are pass/fail; their
logs are kept in `regression-evidence`.
The same report is saved as `regression.md` in `regression-evidence`; machine-readable
`regression.json` is also uploaded as `regression-proof`, including on failure.
Both artifacts are retained for 30 days.

After the workflows land on main:

```sh
gh workflow run regression.yml --ref main -f revision=FULL_40_CHARACTER_COMMIT
```

For pre-merge diagnostics, add `ci:regression` to a PR. While the label remains,
each source push runs the gates as a job inside the PR's CI run (results and
artifacts are on that CI run). The label takes effect on the next push; to run
immediately, dispatch `regression.yml` on the PR branch with the head commit.
`regression.yml` has no PR trigger, so unlabelled PRs create no extra runs, and
its run list holds only dispatched runs such as release evidence. These runs use hosted Ubuntu runners, read-only
repository permissions and committed synthetic/public fixtures; they need no
private feeds, credentials or homelab access. PR diagnostics do not substitute for
the trusted main-workflow run required by release preparation.

The initial suite recovers these useful checks from the archive:

- Index hydration p99 at synthetic pattern-fanout scale, with the existing 75 ms
  ceiling. Missing, duplicated or nonnumeric measurements fail.
- Browser heap after map/stops initialization, with the existing 100 MiB budget;
  missing Chromium memory instrumentation fails.
- WASM cold-start p95 component/total budgets, both normal and real CDP CPU-throttled.
- Production frontend chunk-size budgets and a 250,000-byte gzip WASM budget.
  `size:check` also walks the static imports of the Text mode start chunks and
  fails if they reach MapLibre (`scripts/check-text-entry-chunks.mjs`).
- Native and WASM routing goldens, nonempty native/WASM binding comparisons and
  Rust/TypeScript PTB decoding parity.
- Native RSS admission and rejection-before-bind process checks.
- City switching and viewport panning (`e2e/perf/city-switch.spec.ts`), ported
  from the [city-switch investigation](diagnostics/city-switch-performance/README.md).
  `scripts/regression/synthetic_cities.py` generates two fixed-seed synthetic
  GTFS cities (about 1,000 and 2,300 stops, round-the-clock service), publishes
  them with `pt-producer republish` and serves each with its own `pt-serve`; the
  browser reaches them through the same API paths as a native host. Twelve
  alternating arrivals at zoom 16 must each complete index activation, resolve
  every in-view badge and settle nonempty stop cards for 500 ms. Four one-second
  pans per zoom (14, 16) in all-stops and urban modes must render frames and
  show cards. Neither workload may run the legacy timetable projection write or
  write its tables after the first city is ready, and page errors fail the gate.
  Switch, badge, card-settlement, frame and long-task timings are recorded in
  `city-switch.json` and `viewport-pan.json` but do not fail yet: the
  investigation's 1 s budget came from a desktop GPU, and CI budgets will be set
  once hosted-runner baselines exist.

Every run compares its measurements with `scripts/regression/baseline.json` and
shows the baseline and relative change next to each value in `regression.md`,
`regression.json` and the run summary. Changes are informational; only budgets
fail. To move the baseline, download `regression-proof` from a passing run and
run `scripts/record-regression-evidence.py --update-baseline regression.json`.

The browser heap workload uses a separate preview build with `VITE_E2E=1` to
expose the existing map inspection handle. Production size budgets run before that
build; instrumented files are never packaged for release. Browser fixtures select
Vilnius and serve its city catalog explicitly, rather than relying on a default
city. Only passing, nonempty required workloads count; a skipped gate cannot create
a passing proof. Timing and memory checks do not retry failed measurements.

The aggregate JS ceiling is 1000 kB, approved after the restored gate measured
published v0.1.2 at about 851 kB. Individual chunk budgets remain unchanged.
Reducing the aggregate footprint and tightening this ceiling remain follow-ups.

Native RSS admission tests validate safeguards, not measured eight-city steady-state
RSS. The archive's private-feed Docker captures, Node-vs-Rust serving comparisons,
old nginx/Portainer deployment jobs and temporal experiments are not copied.
Production-scale RSS/latency/soak profiles can be added as separate workloads once
immutable redistributable inputs, query coverage and calibrated baselines exist;
these small fixtures must not be represented as production capacity evidence.

## Release evidence

Every push to main automatically runs `release.yml`, which uploads the validated
archives for all five platforms with 30-day retention. Tagging that exact commit
reuses those archives; if validation is still running, RC preparation waits for it.
The ordinary source CI job continues to provide fast feedback independently.
Release validation is also manually dispatchable for commits without retained builds.

RC preparation selects an eligible run of each workflow for the tag's exact
source commit. A dispatch's `head_sha` identifies workflow code, so source identity
is checked from the explicit revision and downloaded evidence instead. Gate control
scripts come from the workflow commit in a separate checkout, so the selected
source need not contain those new scripts; its own fixtures/bindings must still
satisfy the current gate contracts.

Regression proof must come from a successful manual run of `regression.yml` on
main, identify the selected run and exact source commit, show an unchanged tracked
source tree, and pass every required workload. Missing/failed/skipped evidence
blocks drafting. Expired or unbuilt evidence triggers a new run; a newer failed
run cannot silently fall back to an older success. Diagnostic artifacts and proof
are retained for 30 days.

Release archives retain their own exact-source checksums, metadata and platform
validation. No archive from an ordinary PR/source CI run can be promoted. A tag
can trigger missing builds/gates automatically without imposing that cost on
ordinary merges. `prepare-release-draft.py TAG --check-only` verifies existing
proof/artifacts and never dispatches builds or creates a release.

## Required checks, security and caches

The main-branch ruleset requires the GitHub Actions **CI** aggregate. It includes
source checks when needed and the reusable security workflow. Existing admin
bypasses and signature/history protections are preserved. Secret scanning runs
for every change, including prose; dependency auditing runs for dependency or CI
configuration changes, manual CI and weekly scheduled scans. Production npm high
and critical advisories and RustSec vulnerabilities block CI. The full npm
dependency-tree report includes development tooling and reports findings as
warnings and in the job summary, with JSON retained for 14 days. Scanner
execution/report errors still fail the job. Gitleaks is pinned by image digest
and redacts findings. Exceptions cover only PEM parser delimiters and
published RFC test vectors at their exact source path; a negative test proves
that other keys and paths still fail.

Node, pnpm, Rust dependencies, wasm-pack and cargo-audit use pinned tools and
caches separated by OS, architecture, lockfile/toolchain and build profile.
Only trusted main source runs save caches; PRs and alternate source revisions
restore without saving. Host validation runners restore the pnpm store only:
they receive no Rust build outputs or initialized runtime state.

After packaging, release validation prepares a signed reference OSM catalog
once, then runs native and Docker lifecycle checks in parallel on separate fresh
runners. Both receive the exact same candidate archive and signed OSM inputs;
private signing keys and builder scratch data stay on the preparation runner.
Each validator initializes its own GTFS state and derives its own route probe.
Both must pass before the installable Linux archive is retained for release.

## Build once: RC, staging and stable promotion

The release channel is separate from the artifact's source and embedded component
versions. Build the intended final component versions before tagging an RC;
never edit an archive to replace an RC label during promotion.

1. Tag the intended source commit `vX.Y.Z-rc.N`. The RC draft workflow requires
   exact-commit regression evidence and all validated platform archives. It builds
   only when those inputs are unbuilt or expired. Review the draft, then publish
   it as an **immutable prerelease**. The draft includes `regression.json` and
   `release-evidence.json` with the original run IDs, source SHA and asset hashes.
2. Install the pinned RC assets on staging. Retain the archive hashes and
   environment acceptance results in the private ops deployment record. Exercise
   every enabled city, searches, routing, refresh/restart, upgrade and rollback
   against the intended data. CI's reference-city checks do not replace this.
3. Once accepted, create `vX.Y.Z` on **the same commit**, then run:

   ```sh
   gh workflow run promote-release.yml --ref main \
     -f source-rc=vX.Y.Z-rc.N -f tag=vX.Y.Z
   ```

   This copies the immutable RC's assets unchanged into a separate stable draft.
   It requires the matching RC/version/commit, complete original proof, successful
   trusted exact-commit validation runs and matching GitHub/download/upload
   SHA-256 digests. It never dispatches a build or falls back to rebuilding.
   Expiry of Actions artifacts does not require rebuilding a published RC.
4. Review and publish the stable draft, marking it latest when appropriate.
   Deploy the same archive hashes to production. Keep environment acceptance,
   immutable data inputs and rollback state in ops; public release promotion does
   not switch production or claim operator acceptance.

For a hotfix, install the immutable RC directly on production after the required
acceptance checks, then promote that RC to the stable version later. Update the
ops release identity after verifying matching hashes; the running application
does not need to be rebuilt or replaced just to change the public version tag.
A code or asset change requires a new RC and fresh acceptance.

Stable tags do not trigger the build/draft workflow. Manual stable drafting is
rejected unless it uses the explicit RC promotion workflow. Existing published
releases remain unchanged. To validate a proposed promotion without writing:

```sh
GH_REPO=uerban/ptn python3 scripts/promote-release.py vX.Y.Z \
  --from-rc vX.Y.Z-rc.N --check-only
```

GitHub locks published immutable release assets and tags, but allows editing
release notes and prerelease/latest flags. Stable publication uses a separate
release/tag, preserving the RC. See [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
