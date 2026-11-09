# Privacy threat-model harness

Asserts that the app's outbound network behavior matches what the rider
allowed. Every optional network service is gated by its own decision
(`canUse` in `src/privacy/canUse.ts`); the privacy level adds stricter
handling on top, such as coordinate rounding. The harness records each
outbound request and compares it with per-level golden snapshots.

## Why this exists

A new network call that skips its decision check, or a level that stops
tightening what it should, is easy to miss. This harness catches
both by comparing every request against what each level is expected to send.

It gives spec authors two primitives:

1. Boot the app at any privacy level **before** the first render, on a
   profile that has already completed first-run setup with the Recommended
   decisions (`seedCompletedSetup`), so every code path observes the
   configured state from the start.
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
**stricter** than the chosen level's floor. Network services are not policy
axes: the older network-related axes are kept only so state stored by earlier
versions can still be read, and do not decide whether a request is sent. Use overrides for tests that
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

Drift without the env flag is a failure; goldens are never written automatically.

Every baseline boots with the same Recommended decisions, so the
differences between levels come from level-specific handling (for example
how many POI tiles a level fetches), not from which services are allowed.

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
├── service-alerts.spec.ts     ← alerts wait for a grant and name only the city
├── referrer.spec.ts           ← no request carries the page address as referrer
├── smoke.spec.ts              ← guards the harness primitives themselves
├── playwright.config.ts       ← scoped config for baseline snapshots (T-X-4b)
└── __snapshots__/             ← per-level golden files (T-X-4b)
```

## Running

No CI job runs this harness yet. Run it locally before pushing changes that
add or gate a network request:

```sh
pnpm --filter @pt/frontend test:privacy-harness
```

A diff against any golden in `__snapshots__/` fails the run.
