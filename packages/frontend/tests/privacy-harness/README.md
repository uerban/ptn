# Privacy threat-model harness

Scaffolding (T-X-4a) for asserting that the app's outbound network behavior
matches the active `PrivacyPolicy`. Used by per-level golden snapshots
(T-X-4b) and CI integration (T-X-4c).

## Why this exists

The app must behave differently at each privacy level — Hardened must not
emit reverse-geocode requests, Strict must round coordinates before any
external call, Paranoid must disable third-party providers entirely. Without
a regression harness these guarantees rot the moment someone adds a new
network call without re-checking each preset.

This harness gives spec authors two primitives:

1. Boot the app at any privacy level **before** the first render —
   so every code path observes the configured policy from the start.
2. Capture every outbound request and assert against a declarative
   per-kind pattern.

## Usage

```ts
import { test } from "@playwright/test";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  installNetworkRecorder,
  assertNetworkPattern,
} from "../../tests/privacy-harness/assertNetworkPattern";

test("Hardened: no reverse-geocode on map tap", async ({ page }) => {
  await bootAtPrivacyLevel(page, "hardened");
  const recorder = installNetworkRecorder(page);

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // ... drive the scenario ...

  assertNetworkPattern(recorder, [
    { kind: "reverse-geocode", maxCount: 0 },
    { kind: "tile", minCount: 1 },
  ]);
  recorder.stop();
});
```

### Optional: per-axis overrides

`bootAtPrivacyLevel` accepts a `Partial<PrivacyPolicy>` of overrides. The
override-ratchet rule still applies: an override only takes effect if it is
**stricter** than the chosen level's floor. Use overrides for tests that
need a non-preset axis combination — but prefer one of the five named levels
when possible to keep snapshot files comparable across milestones.

```ts
await bootAtPrivacyLevel(page, "standard", {
  m11TileDefense: "prefetch-padding",
});
```

### Request kinds

The classifier in `assertNetworkPattern.ts` recognizes the surfaces the M7a
threat-model needs to differentiate:

- `reverse-geocode`, `forward-geocode` — coord-bearing or query-bearing
  geocoder traffic
- `tile` — map raster / vector tile fetches
- `poi-bundle` — bundled POI dataset downloads (M10/M11)
- `stops-nearby`, `stops-all`, `departures`, `raptor-data`,
  `color-config`, `health` — known internal API surfaces
- `service-alerts` — the city-wide alerts request (`/api/<city>/alerts`);
  `service-alerts.spec.ts` checks it waits for Recommended setup or a grant
  and names only the city
- `other` — anything not classified above

When a future milestone introduces a new external surface, add a matcher to
`KIND_MATCHERS` rather than letting the request fall into `other` — the
harness assertions are opt-in and silent on unlisted kinds.

## Per-level baseline snapshots (T-X-4b)

`snapshot.ts` exposes `captureNetworkPatternAt(page, level, scenario)`,
which boots the app at the requested level, records every outbound
request, and rolls it up by `RequestKind`. `baseline.spec.ts` runs the
`boot-idle-5s` scenario once per level and diffs against the golden file
in `__snapshots__/boot-idle-5s.{level}.json`.

Run baselines locally:

```sh
pnpm --filter @pt/frontend exec playwright test \
  --config=tests/privacy-harness/playwright.config.ts
```

Regenerate goldens after an intentional behavior change:

```sh
UPDATE_PRIVACY_SNAPSHOTS=1 pnpm --filter @pt/frontend exec playwright test \
  --config=tests/privacy-harness/playwright.config.ts
```

Drift without the env flag is a failure — CI never auto-writes goldens.

At M7a the five baselines are expected to be **identical**: no privacy
axis currently gates a network surface (errorReporter is policy-gated in
T-11 but never emits outbound traffic on its own). The baselines diverge
once M9/M10/M11 introduce tier-gated reverse-geocode, POI, and tile
surfaces — that is when this harness earns its keep.

The captured pattern excludes the `other` bucket: dev-mode Vite serves
every ES module individually and that count would thrash on every
bundle-layout change. If a future milestone needs coverage over an
uncategorized surface, add a matcher to `KIND_MATCHERS` in
`assertNetworkPattern.ts` rather than re-enabling `other`.

## Adding a new scenario

Extend the `Scenario` union in `snapshot.ts`, branch on it in
`captureNetworkPatternAt`, and parametrize `baseline.spec.ts` so the
new scenario runs per level. Regenerate goldens with
`UPDATE_PRIVACY_SNAPSHOTS=1`. Keep each scenario:

- Deterministic — no real-time clocks, no live external services, mock
  network surfaces with `mockApi` from `e2e/helpers/mock-api.ts`.
- Bounded — pick a clear "scenario completion" signal (`networkidle`, a
  visible element, a known number of frames) before asserting.
- Self-contained — call `recorder.reset()` if you need to assert phases
  separately within one test.

## File layout

```
tests/privacy-harness/
├── README.md                  ← you are here (T-X-4a)
├── bootAtLevel.ts             ← seed privacyStore via addInitScript (T-X-4a)
├── assertNetworkPattern.ts    ← record + classify + assert (T-X-4a)
├── snapshot.ts                ← captureNetworkPatternAt() (T-X-4b)
├── baseline.spec.ts           ← per-level baseline scenario (T-X-4b)
├── playwright.config.ts       ← scoped config for baseline snapshots (T-X-4b)
└── __snapshots__/             ← per-level golden files (T-X-4b)
```

## Wiring into CI

The `performance` job in `.github/workflows/ci.yml` runs
`pnpm --filter @pt/frontend test:privacy-harness` on every push and pull
request. A diff against any golden in `__snapshots__/` fails the job; the
smoke spec also runs under this script and guards the harness primitives
themselves.

Run locally before pushing:

```sh
pnpm --filter @pt/frontend test:privacy-harness
```
