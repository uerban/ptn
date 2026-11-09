import { expect, type Page, type Request } from "@playwright/test";

// Coarse classification of outbound traffic the threat-model harness cares
// about. Add new kinds here as future milestones introduce new external
// surfaces; keep matchers defensive (false negatives over false positives).
export type RequestKind =
  | "reverse-geocode"
  | "forward-geocode"
  | "tile"
  | "glyphs"
  | "micromap"
  | "poi-bundle"
  | "stops-nearby"
  | "stops-all"
  | "departures"
  | "catalog-bundle"
  | "catalog-ready"
  | "color-config"
  | "health"
  | "service-alerts"
  | "other";

export interface ExpectedPattern {
  kind: RequestKind;
  // Inclusive bounds. Use { minCount: 0, maxCount: 0 } to assert "must not
  // happen". Use { minCount: 1 } (and omit maxCount) to assert "at least one".
  minCount?: number;
  maxCount?: number;
}

export interface CapturedRequest {
  url: string;
  method: string;
  postData: string | null;
  resourceType: string;
  kind: RequestKind;
}

export interface NetworkRecorder {
  requests: CapturedRequest[];
  reset(): void;
  stop(): void;
}

const KIND_MATCHERS: Array<{ kind: RequestKind; test: (url: string) => boolean }> = [
  { kind: "stops-nearby", test: (u) => /\/api\/[^/]+\/stops\/nearby/.test(u) },
  { kind: "stops-all", test: (u) => /\/api\/[^/]+\/stops\/all/.test(u) },
  { kind: "departures", test: (u) => /\/api\/[^/]+\/departures/.test(u) },
  // The routing catalog. It moved from `/gtfs/raptor-data` (JSON, deleted)
  // to `/raptor-bundle` (PTB bytes); without this matcher the boot-time
  // catalog fetch would land in `other`, which the snapshots exclude — the
  // largest single request of a cold boot, invisible to the baselines.
  { kind: "catalog-bundle", test: (u) => /\/api\/[^/]+\/raptor-bundle/.test(u) },
  // The other half of the same fetch: every bundle read brackets itself with
  // `/ready` for the generation it is about to trust. Counted separately so a
  // bracket that stops pairing with a bundle read shows up as a count skew
  // rather than hiding in `other`. `[^/]+` cannot span a slash, so this does
  // not swallow `/health/ready` — that stays `health`.
  { kind: "catalog-ready", test: (u) => /\/api\/[^/]+\/ready(\?|$)/.test(u) },
  { kind: "color-config", test: (u) => /\/api\/[^/]+\/color-config/.test(u) },
  { kind: "health", test: (u) => /\/api\/[^/]+\/health/.test(u) },
  // City-wide service alerts: off until recommended setup or a grant.
  { kind: "service-alerts", test: (u) => /\/api\/[^/]+\/alerts(\?|$)/.test(u) },
  // Reverse before forward: reverse-geocode URLs typically include `?lat=`+`lon=`,
  // forward URLs include `?q=` / `?text=`. Order matters for tiles vs geocode
  // when a provider muxes endpoints.
  {
    kind: "reverse-geocode",
    test: (u) =>
      /\/(reverse|reverse-geocode)\?/.test(u) ||
      (/geocode/i.test(u) && /[?&](lat|latitude)=/.test(u)),
  },
  {
    kind: "forward-geocode",
    test: (u) =>
      /\/(search|forward|forward-geocode)\?/.test(u) ||
      (/geocode/i.test(u) && /[?&](q|text|query)=/.test(u)),
  },
  // Same-origin app assets that would otherwise land in the deliberately
  // broad "tile" bucket below. Both are static files served from PTN's own
  // origin and identical for every user, so recording them as tiles would
  // read as "this preset fetches map tiles" — the exact claim the tile bucket
  // exists to make. Ordered before it.
  { kind: "glyphs", test: (u) => /\/glyphs\/[^/]+\/[^/]+\.pbf(\?|$)/.test(u) },
  // Anchored on the artifact filename, not the path segment: under the dev
  // server the app's own source files (/src/map/micromap/types.ts) share it.
  { kind: "micromap", test: (u) => /\/micromap\/[^/]+\.micromap\.br(\?|$)/.test(u) },
  // Tile URLs vary widely; match common patterns. We deliberately keep this
  // broad — false positives in the "tile" bucket are safer than misclassifying
  // a tile request as "other" and letting a regression slip past.
  {
    kind: "tile",
    test: (u) =>
      /\/tiles?\//.test(u) ||
      /\/poi-tile\//.test(u) ||
      /\.(pbf|mvt)(\?|$)/.test(u) ||
      /\/\d+\/\d+\/\d+\.(png|jpg|webp)(\?|$)/.test(u),
  },
  { kind: "poi-bundle", test: (u) => /\/(poi|pois)\//.test(u) },
];

export function classifyRequest(url: string): RequestKind {
  for (const { kind, test } of KIND_MATCHERS) {
    if (test(url)) return kind;
  }
  return "other";
}

// Begins recording every outbound request the page makes (skipping `data:` /
// `blob:` browser-internal URLs). Returns a recorder whose `requests` array
// can be passed straight to `assertNetworkPattern`. Call `stop()` in your
// test teardown to detach the listener.
export function installNetworkRecorder(page: Page): NetworkRecorder {
  const requests: CapturedRequest[] = [];
  const onRequest = (req: Request) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    requests.push({
      url,
      method: req.method(),
      postData: req.postData(),
      resourceType: req.resourceType(),
      kind: classifyRequest(url),
    });
  };
  page.on("request", onRequest);
  return {
    requests,
    reset: () => {
      requests.length = 0;
    },
    stop: () => {
      page.off("request", onRequest);
    },
  };
}

// Asserts the recorded network traffic matches every expected pattern's
// count bounds. Each `ExpectedPattern` is checked independently — a request
// counts toward exactly one kind (the first matcher in `KIND_MATCHERS` to
// fire). Unlisted kinds are ignored, so callers explicitly opt in to the
// surfaces they care about per scenario.
export function assertNetworkPattern(
  recorder: NetworkRecorder | CapturedRequest[],
  expected: ExpectedPattern[],
): void {
  const requests = Array.isArray(recorder) ? recorder : recorder.requests;
  for (const pattern of expected) {
    const matched = requests.filter((r) => r.kind === pattern.kind);
    const count = matched.length;
    const min = pattern.minCount ?? 0;
    const max = pattern.maxCount ?? Number.POSITIVE_INFINITY;
    expect(
      count,
      `Expected ${pattern.kind} request count in [${min}, ${max === Number.POSITIVE_INFINITY ? "∞" : max}], got ${count}.\n` +
        `URLs:\n${matched.map((r) => `  - ${r.method} ${r.url}`).join("\n") || "  (none)"}`,
    ).toBeGreaterThanOrEqual(min);
    expect(
      count,
      `Expected ${pattern.kind} request count <= ${max === Number.POSITIVE_INFINITY ? "∞" : max}, got ${count}.\n` +
        `URLs:\n${matched.map((r) => `  - ${r.method} ${r.url}`).join("\n") || "  (none)"}`,
    ).toBeLessThanOrEqual(max);
  }
}
