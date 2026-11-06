# CI and release gates

Routine checks and release preparation have different costs and purposes.

| Workflow | Trigger | Required work |
| --- | --- | --- |
| **CI** | Pull requests, pushes to main, manual | Classify changed paths; build and test source when needed |
| **Regression gates** | Manual exact-commit run; PR with `ci:regression` label | Performance, memory safeguards, WASM and PTB parity budgets |
| **Release candidate validation** | Manual exact-commit run, including dispatch by release preparation | Build all installable platforms and validate native/Docker fresh-host lifecycle |
| **Draft release from validated artifacts** | Version tag or manual existing tag | Require matching regression evidence and validated archives before creating a draft |

## Routine CI

README files, root prose and Markdown under `docs/` or `.github/` do not compile
the application. Unknown paths, executable examples, JSON budget/config changes,
workflow changes, mixed code/documentation changes and manual CI runs take the
source path. Deletions and both sides of renames count; push classification covers
all commits since the previous push. The workflow compares local Git history,
so it does not depend on the Actions path-filter file limit.

The **CI** result job always runs. It accepts a deliberate prose-only skip and
fails on classification failures or failed/cancelled source jobs. Use that single
status for branch protection; do not require optional regression or platform jobs.
A workflow skipped by a top-level path filter can leave required checks pending;
this design uses job conditions instead. See the
[GitHub workflow-trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

Source CI retains workspace builds/tests, typechecks and lint. It does not fetch
reference-city OSM/GTFS inputs, package the platform matrix or run deployment
lifecycle checks. Those remain mandatory during release candidate validation.

## Run regressions when needed

After the workflows land on main:

```sh
gh workflow run regression.yml --ref main -f revision=FULL_40_CHARACTER_COMMIT
```

For pre-merge diagnostics, add `ci:regression` to a PR. Subsequent commits rerun
the gate while that label remains. These runs use hosted Ubuntu runners, read-only
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
- Native and WASM routing goldens, nonempty native/WASM binding comparisons and
  Rust/TypeScript PTB decoding parity.
- Native RSS admission and rejection-before-bind process checks.

The browser heap workload uses a separate preview build with `VITE_E2E=1` to
expose the existing map inspection handle. Production size budgets run before that
build; instrumented files are never packaged for release. Browser fixtures select
Vilnius and serve its city catalog explicitly, rather than relying on a default
city. Only passing, nonempty required workloads count; a skipped gate cannot create
a passing proof. Timing and memory checks do not retry failed measurements.

The aggregate JS ceiling currently remains 800 kB. The restored gate measured
published v0.1.2 at about 851 kB, so this is a known release blocker pending a
reviewed size reduction or budget change. All individual chunk budgets passed.

Native RSS admission tests validate safeguards, not measured eight-city steady-state
RSS. The archive's private-feed Docker captures, Node-vs-Rust serving comparisons,
old nginx/Portainer deployment jobs and temporal experiments are not copied.
Production-scale RSS/latency/soak profiles can be added as separate workloads once
immutable redistributable inputs, query coverage and calibrated baselines exist;
these small fixtures must not be represented as production capacity evidence.

## Release evidence

Release preparation selects an eligible run of each workflow for the tag's exact
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
