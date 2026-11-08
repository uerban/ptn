import type { Page, Request } from "@playwright/test";

/**
 * The documented request allowlist: every request the app may make, grouped
 * by the data flow it belongs to. A request is allowed only when its group is
 * active for the profile under test. Unknown same-origin API paths and every
 * other origin are never allowed, so a new endpoint or provider fails these
 * assertions until it is listed here with its flow.
 *
 * Groups:
 *   shell        app code, styles, fonts, icons, translations, service worker
 *   transit-data operator.transit-data, the one necessary flow
 *   map-assets   map-only files on the app origin: Map mode or a temporary map
 *   <flow id>    an optional flow, active only while it is allowed
 */
export type RequestGroup =
  | "shell"
  | "transit-data"
  | "map-assets"
  | "operator.realtime"
  | "operator.service-alerts"
  | "operator.nearby-stop-centroid"
  | "operator.place-search"
  | "operator.remote-routing"
  | "operator.client-report";

interface Rule {
  readonly group: RequestGroup;
  readonly description: string;
  readonly matches: (url: URL) => boolean;
}

const API = (rest: string) => new RegExp(`^/api/[a-z0-9-]+/${rest}`);

/** Order matters: the first matching rule decides the group. */
export const REQUEST_RULES: readonly Rule[] = [
  // Optional same-origin endpoints first, so the broad transit-data rules
  // below can never swallow them.
  {
    group: "operator.service-alerts",
    description: "City-wide service alerts.",
    matches: (u) => API("alerts$").test(u.pathname),
  },
  {
    group: "operator.realtime",
    description: "Live departure times (real-time tiles and per-route updates).",
    matches: (u) => API("gtfs/rt-tile/").test(u.pathname) || API("rt/").test(u.pathname),
  },
  {
    group: "operator.nearby-stop-centroid",
    description: "Server-side nearby stop lookup.",
    matches: (u) => API("stops/nearby").test(u.pathname),
  },
  {
    group: "operator.place-search",
    description: "Place search answered by the operator.",
    matches: (u) =>
      (API("address-search$").test(u.pathname) && u.searchParams.has("q")) ||
      // A self-hosted geocoder on the app origin (`<base>?q=`, `<base>/search`, `/reverse`).
      (/^\/(?:api\/)?geocod/.test(u.pathname) && u.pathname !== "/geocoder-config.json"),
  },
  {
    group: "operator.remote-routing",
    description: "Journey planning on the operator's server.",
    matches: (u) => API("plan$").test(u.pathname) || u.pathname === "/api/plan",
  },
  {
    group: "operator.client-report",
    description: "Engine failure reports.",
    matches: (u) => API("client-report").test(u.pathname),
  },
  {
    group: "transit-data",
    description:
      "City catalog, timetable bundle and tiles, stops, shapes, transfers, colors, place data and walking graph.",
    matches: (u) =>
      u.pathname === "/api/cities" ||
      /^\/api\/gtfs\/poi-tile\//.test(u.pathname) ||
      API(
        "(?:gtfs/(?:manifest|schedule-tile/|shapes/)|raptor-bundle|ready$|version$|health|color-config|stops/all|transfers/fetch|route-geometry/fetch|departures|healthy-stops|address-search/(?:manifest|bundle))",
      ).test(u.pathname) ||
      /^\/(?:poi|osm|walk-graph)\//.test(u.pathname) ||
      u.pathname === "/geocoder-config.json",
  },
  {
    group: "map-assets",
    description: "Minimal offline map, glyphs and MapLibre code.",
    matches: (u) =>
      /^\/(?:micromap|glyphs)\//.test(u.pathname) || /maplibre|vendor-map/i.test(u.pathname),
  },
  {
    group: "shell",
    description: "The app's own static files.",
    matches: (u) => !u.pathname.startsWith("/api/"),
  },
];

export function classifyAppRequest(rawUrl: string, appOrigin: string): RequestGroup | "external" | "unknown" {
  const url = new URL(rawUrl, appOrigin);
  if (url.origin !== new URL(appOrigin).origin) return "external";
  return REQUEST_RULES.find((rule) => rule.matches(url))?.group ?? "unknown";
}

export interface RecordedRequest {
  readonly url: string;
  readonly referer: string | undefined;
}

/** Record every http(s) request the page and its workers make. */
export function recordRequests(page: Page): RecordedRequest[] {
  const seen: RecordedRequest[] = [];
  const onRequest = (request: Request) => {
    const url = request.url();
    if (!/^https?:/.test(url)) return;
    seen.push({ url, referer: request.headers()["referer"] });
  };
  page.context().on("request", onRequest);
  return seen;
}

/** Requests whose group is not active, as `group url` lines. */
export function disallowedRequests(
  requests: readonly RecordedRequest[],
  appOrigin: string,
  active: readonly RequestGroup[],
): string[] {
  const allowed = new Set<string>(active);
  return requests
    .map(({ url }) => ({ url, group: classifyAppRequest(url, appOrigin) }))
    .filter(({ group }) => !allowed.has(group))
    .map(({ url, group }) => `${group} ${url}`);
}

/**
 * Referrers that carry more than the app's origin. Page addresses can name
 * stops, lines, trips and coordinates (`/search?fromStopId=…`, `/stop/…`), so
 * a referrer may be absent or the bare origin, never a page path or query.
 * Workers send their own script address (`/assets/…-worker.js`), which names
 * no page and is the same for every user.
 */
export function pathBearingReferrers(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter(({ url, referer }) => {
      if (!referer) return false;
      // Dev-server module and font paths do not exist in a production build,
      // where styles are linked files; the production project covers those.
      if (/^\/(?:@fs|@vite|@id|node_modules|src)\//.test(new URL(url).pathname)) return false;
      const ref = new URL(referer);
      if (/\.(?:m?js|tsx?)$/.test(ref.pathname)) return false;
      return ref.pathname !== "/" || ref.search !== "" || ref.hash !== "";
    })
    .map(({ url, referer }) => `${url} <- ${referer}`);
}
