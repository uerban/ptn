/**
 * Requests the app may make before setup is complete.
 *
 * Until the user has chosen a city and a starting preset, only the app shell
 * and the transit data needed to describe the chosen city may load. This is
 * an explicit allowlist rather than "anything on our origin": the origin
 * also serves optional endpoints (live departures, service alerts, nearby
 * lookup, place search) that must not run before a choice.
 *
 * Everything listed belongs to `operator.transit-data`, the one necessary
 * flow, and is disclosed as such in setup.
 */

export interface BootstrapRequestRule {
  readonly id: string;
  readonly description: string;
  readonly matches: (url: URL) => boolean;
}

const path = (url: URL) => url.pathname;

/** Paths on the app origin that are never part of the app shell before setup. */
const OPTIONAL_PATH_PREFIXES: readonly RegExp[] = [
  /^\/api\//, // only the explicitly listed API calls below
  /^\/poi\//,
  /^\/osm\//,
  /^\/micromap\//,
  /^\/glyphs\//,
  /^\/geocoder-config\.json$/,
];

/** Map-only code (D3): not loaded before the user chooses Map. */
const MAP_ONLY_CODE = /(?:maplibre|vendor-map)/i;

export const SETUP_BOOTSTRAP_RULES: readonly BootstrapRequestRule[] = [
  {
    id: "city-catalog",
    description: "The list of cities this host serves.",
    matches: (url) => path(url) === "/api/cities",
  },
  {
    id: "transit-manifest",
    description:
      "The chosen city's transit-data manifest, which also lists whether the city publishes live departures and service alerts.",
    matches: (url) => /^\/api\/[a-z0-9-]+\/gtfs\/manifest$/.test(path(url)),
  },
  {
    id: "app-shell",
    description:
      "The app's own code, styles, fonts, icons, translations, deployment configuration and service worker.",
    matches: (url) =>
      !OPTIONAL_PATH_PREFIXES.some((prefix) => prefix.test(path(url))) &&
      !MAP_ONLY_CODE.test(path(url)),
  },
];

/**
 * True when `rawUrl` may be requested before setup completes. Requests to any
 * other origin are never allowed.
 */
export function isAllowedBeforeSetup(rawUrl: string, appOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, appOrigin);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  if (url.origin !== new URL(appOrigin).origin) return false;
  return SETUP_BOOTSTRAP_RULES.some((rule) => rule.matches(url));
}
