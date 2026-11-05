import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Page } from "@playwright/test";
import type { PrivacyLevel } from "@pt/shared";
import { mockApi } from "../../e2e/helpers/mock-api";
import { bootAtPrivacyLevel } from "./bootAtLevel";
import {
  installNetworkRecorder,
  type RequestKind,
} from "./assertNetworkPattern";

// Minimal MapLibre style that declares no sources and no layers. Served in
// place of the real Carto CDN responses so the harness does not depend on
// live third-party tile fan-out — otherwise the baseline snapshots encode
// whatever raster tile count Carto happens to serve at the fixed viewport,
// and PRs fail on upstream tiling changes that have nothing to do with
// privacy. The tile matcher in `KIND_MATCHERS` stays in place; M11 will
// exercise it against its own tile-defense fixtures when that milestone
// introduces level-gated tile behavior.
const EMPTY_MAP_STYLE = {
  version: 8,
  sources: {},
  layers: [],
  glyphs: "about:blank/{fontstack}/{range}.pbf",
  sprite: "about:blank",
};

async function stubMapTiles(page: Page): Promise<void> {
  await page.route("**/basemaps.cartocdn.com/**", (route) => {
    const url = route.request().url();
    if (url.endsWith(".json") || /style\.json/.test(url)) {
      route.fulfill({ json: EMPTY_MAP_STYLE });
      return;
    }
    // Anything else under the Carto CDN (sprites, glyphs, raster tiles)
    // is aborted — the empty style should prevent these from firing, but
    // a stray request is safer aborted than proxied to the live CDN.
    route.abort();
  });
}

// A captured "pattern" is the per-kind count of outbound requests seen
// during a scenario run. Omitted kinds implicitly mean zero — the comparator
// treats `{}` and `{ tile: 0 }` as equivalent, so we keep snapshots terse.
export type Pattern = Partial<Record<RequestKind, number>>;

// The named scenarios the harness can replay per level. Keep this union
// closed so a typo in a spec becomes a compile error, and every milestone
// that adds a scenario also updates the golden files.
export type Scenario = "boot-idle-5s";

export interface CaptureResult {
  pattern: Pattern;
  // Retained for diagnostics — tests that fail a comparison log these so
  // a regression is obvious at a glance without having to re-run with a
  // recorder attached.
  urls: string[];
}

const SNAPSHOT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__snapshots__",
);

export function snapshotPath(
  level: PrivacyLevel,
  scenario: Scenario,
): string {
  return join(SNAPSHOT_DIR, `${scenario}.${level}.json`);
}

export function loadSnapshot(
  level: PrivacyLevel,
  scenario: Scenario,
): Pattern | null {
  const path = snapshotPath(level, scenario);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse snapshot at ${path}: ${(err as Error).message}. ` +
        `Regenerate with UPDATE_PRIVACY_SNAPSHOTS=1.`,
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { pattern?: unknown }).pattern !== "object" ||
    (raw as { pattern?: unknown }).pattern === null
  ) {
    throw new Error(
      `Invalid snapshot shape at ${path}: expected { pattern: { ... } }. ` +
        `Regenerate with UPDATE_PRIVACY_SNAPSHOTS=1.`,
    );
  }
  return (raw as { pattern: Pattern }).pattern;
}

export function writeSnapshot(
  level: PrivacyLevel,
  scenario: Scenario,
  pattern: Pattern,
): void {
  // An empty rolled-up pattern means the recorder saw zero classified
  // requests — either the app failed to boot, mockApi blocked everything,
  // or the recorder detached early. Refuse to write rather than silently
  // bricking the golden so the next run passes against `{}`.
  if (Object.keys(rollup(pattern)).length === 0) {
    throw new Error(
      `Refusing to write empty snapshot for ${level}/${scenario}. ` +
        `The recorder produced no classified requests; investigate before ` +
        `regenerating.`,
    );
  }
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
  const path = snapshotPath(level, scenario);
  writeFileSync(path, JSON.stringify({ pattern }, null, 2) + "\n");
}

// Normalizes to a dense, comparable shape. Empty counts drop out so
// `{ tile: 3, "reverse-geocode": 0 }` round-trips to `{ tile: 3 }`.
//
// `other` is intentionally excluded: dev-mode Vite serves every ES module
// individually and bundle-layout churn would constantly re-baseline every
// snapshot. The harness README documents that assertions are opt-in on
// classified kinds — the goldens follow the same rule. If a future
// milestone needs coverage over an uncategorized surface, the right fix is
// to add a matcher to `KIND_MATCHERS`, not to track `other` here.
function rollup(pattern: Pattern): Pattern {
  const out: Pattern = {};
  for (const k of Object.keys(pattern) as RequestKind[]) {
    if (k === "other") continue;
    const v = pattern[k] ?? 0;
    if (v > 0) out[k] = v;
  }
  return out;
}

export function patternsEqual(a: Pattern, b: Pattern): boolean {
  const ra = rollup(a);
  const rb = rollup(b);
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if ((ra[k as RequestKind] ?? 0) !== (rb[k as RequestKind] ?? 0)) {
      return false;
    }
  }
  return true;
}

// Runs the scenario against the app and returns the observed pattern. The
// caller is responsible for asserting against a golden file — this keeps
// `captureNetworkPatternAt` usable both for new snapshot generation and for
// regression checks.
export async function captureNetworkPatternAt(
  page: Page,
  level: PrivacyLevel,
  scenario: Scenario,
): Promise<CaptureResult> {
  await bootAtPrivacyLevel(page, level);
  await mockApi(page);
  await stubMapTiles(page);
  const recorder = installNetworkRecorder(page);

  try {
    if (scenario === "boot-idle-5s") {
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
      // Deliberately fixed idle window: `networkidle` is flaky when
      // background tiles keep prefetching, so we use a hard 5s timer to
      // match the scenario name exactly.
      await page.waitForTimeout(5_000);
    } else {
      const _exhaustive: never = scenario;
      throw new Error(`Unknown scenario: ${_exhaustive as string}`);
    }
  } finally {
    recorder.stop();
  }

  const pattern: Pattern = {};
  const urls: string[] = [];
  for (const req of recorder.requests) {
    pattern[req.kind] = (pattern[req.kind] ?? 0) + 1;
    urls.push(`${req.method} ${req.url}`);
  }
  return { pattern: rollup(pattern), urls };
}

// Opt-in regeneration is controlled by env var — the CI job must run with
// UPDATE_PRIVACY_SNAPSHOTS unset so a drift is a failure, not a silent
// overwrite.
export function shouldUpdateSnapshots(): boolean {
  return process.env.UPDATE_PRIVACY_SNAPSHOTS === "1";
}
