/**
 * View model for the setup city list. Pure: it decides whether a filter is
 * worth showing, and whether cities are listed flat or grouped by country
 * (and, for large catalogs, by continent). Rendering lives in `CitySelection`.
 */
import type { CityConfig } from "../config/cities.ts";

/** Where the setup city list came from: a fresh or cached catalog, only the
 * cities with data on this device, or nothing at all. */
export type CatalogStatus = "fresh" | "cached" | "device-only" | "failed";

/** Fewer openable cities than this: the list is short enough without a filter. */
export const FILTER_MIN_CITIES = 8;
/** More openable cities than this: cities are grouped by country. */
export const GROUP_ABOVE_CITIES = 10;
/** More openable cities than this: countries are grouped by continent. */
export const CONTINENT_ABOVE_CITIES = 25;

export interface CityRow {
  readonly kind: "city";
  readonly city: CityConfig;
  /** Country shown next to the name; `null` inside the city's own country group
   * or when the catalog does not name a country. */
  readonly country: string | null;
}

export interface CityGroup {
  readonly kind: "group";
  /** Stable key, e.g. `country:PL` or `continent:150`. */
  readonly id: string;
  readonly label: string;
  readonly children: readonly CityNode[];
  /** Every city in this group, at any depth. */
  readonly cityIds: readonly string[];
}

export type CityNode = CityRow | CityGroup;

export interface CityListView {
  readonly showFilter: boolean;
  readonly grouped: boolean;
  readonly nodes: readonly CityNode[];
}

export type RegionNamer = (code: string) => string | null;

export interface CityListInput {
  readonly cities: readonly CityConfig[];
  /** Cities that can be opened now; thresholds count only these. */
  readonly openableCount: number;
  readonly installedCityIds: ReadonlySet<string>;
  readonly query: string;
  /** UI locale for sorting and matching. */
  readonly locale: string;
  /** Localized name of an ISO 3166-1 country or UN M49 area code. */
  readonly regionName: RegionNamer;
  /** When set, only these cities, flat (for example cities near the user). */
  readonly onlyCityIds?: ReadonlySet<string> | null;
}

// UN M49 continental areas, by ISO 3166-1 country code. Intl.DisplayNames
// localizes the area codes like any other region.
const CONTINENT_COUNTRIES: Readonly<Record<string, string>> = {
  "150":
    "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
  "142":
    "AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
  "002":
    "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
  "003":
    "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI",
  "005": "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
  "009": "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
};

let continentByCountry: Map<string, string> | null = null;

/** UN M49 continent code of a country, or `null` when unknown. */
export function continentOf(countryCode: string): string | null {
  if (!continentByCountry) {
    continentByCountry = new Map();
    for (const [area, list] of Object.entries(CONTINENT_COUNTRIES)) {
      for (const code of list.split(" ")) continentByCountry.set(code, area);
    }
  }
  return continentByCountry.get(countryCode.toUpperCase()) ?? null;
}

/** Localized region names for `locale`; `null` when the runtime has none. */
export function regionNamer(locale: string): RegionNamer {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale, "en"], { type: "region", fallback: "none" });
  } catch {
    names = null;
  }
  return (code) => {
    try {
      return names?.of(code.toUpperCase()) ?? null;
    } catch {
      return null;
    }
  };
}

const countryCodeOf = (city: CityConfig): string | null =>
  typeof city.countryCode === "string" && /^[A-Za-z]{2}$/.test(city.countryCode)
    ? city.countryCode.toUpperCase()
    : null;

function countryLabel(city: CityConfig, regionName: RegionNamer): string | null {
  const code = countryCodeOf(city);
  return code ? (regionName(code) ?? code) : null;
}

const nodeLabel = (node: CityNode): string => (node.kind === "city" ? node.city.name : node.label);
const nodeCityIds = (node: CityNode): readonly string[] =>
  node.kind === "city" ? [node.city.id] : node.cityIds;

function sortNodes(
  nodes: CityNode[],
  locale: string,
  installed: ReadonlySet<string> | null,
): CityNode[] {
  const rank = (node: CityNode) =>
    installed && node.kind === "city" && installed.has(node.city.id) ? 0 : 1;
  return nodes.sort(
    (a, b) => rank(a) - rank(b) || nodeLabel(a).localeCompare(nodeLabel(b), locale),
  );
}

/** A group of one collapses to its member, recursively. */
function group(id: string, label: string, children: CityNode[]): CityNode {
  if (children.length === 1) return children[0]!;
  return { kind: "group", id, label, children, cityIds: children.flatMap(nodeCityIds) };
}

export function buildCityList(input: CityListInput): CityListView {
  const { cities, locale, regionName } = input;
  const showFilter = input.openableCount >= FILTER_MIN_CITIES;
  const needle = showFilter ? input.query.trim().toLocaleLowerCase(locale) : "";
  const flatRow = (city: CityConfig): CityRow => ({
    kind: "city",
    city,
    country: countryLabel(city, regionName),
  });

  if (input.onlyCityIds) {
    const only = input.onlyCityIds;
    return { showFilter, grouped: false, nodes: cities.filter((c) => only.has(c.id)).map(flatRow) };
  }
  if (needle) {
    const nodes = cities
      .map(flatRow)
      .filter(
        (row) =>
          row.city.name.toLocaleLowerCase(locale).includes(needle) ||
          !!row.country?.toLocaleLowerCase(locale).includes(needle),
      );
    return { showFilter, grouped: false, nodes };
  }
  if (input.openableCount <= GROUP_ABOVE_CITIES) {
    return { showFilter, grouped: false, nodes: cities.map(flatRow) };
  }

  // Countries: a country with one city is that city, labelled with its country.
  const byCountry = new Map<string, CityConfig[]>();
  const loose: CityNode[] = [];
  for (const city of cities) {
    const code = countryCodeOf(city);
    if (!code) loose.push(flatRow(city));
    else byCountry.set(code, [...(byCountry.get(code) ?? []), city]);
  }
  const countryNodes: { code: string; node: CityNode }[] = [];
  for (const [code, members] of byCountry) {
    const node =
      members.length === 1
        ? flatRow(members[0]!)
        : group(
            `country:${code}`,
            regionName(code) ?? code,
            sortNodes(
              members.map((city): CityRow => ({ kind: "city", city, country: null })),
              locale,
              input.installedCityIds,
            ),
          );
    countryNodes.push({ code, node });
  }

  let top: CityNode[];
  if (input.openableCount > CONTINENT_ABOVE_CITIES) {
    const byContinent = new Map<string, CityNode[]>();
    top = [...loose];
    for (const { code, node } of countryNodes) {
      const area = continentOf(code);
      if (!area) top.push(node);
      else byContinent.set(area, [...(byContinent.get(area) ?? []), node]);
    }
    for (const [area, members] of byContinent) {
      top.push(
        group(
          `continent:${area}`,
          regionName(area) ?? area,
          sortNodes(members, locale, input.installedCityIds),
        ),
      );
    }
  } else {
    top = [...loose, ...countryNodes.map((entry) => entry.node)];
  }
  return { showFilter, grouped: true, nodes: sortNodes(top, locale, null) };
}

/** Ids of the groups, outermost first, that hold `cityId`. */
export function groupsHolding(nodes: readonly CityNode[], cityId: string | null): string[] {
  if (!cityId) return [];
  for (const node of nodes) {
    if (node.kind === "group" && node.cityIds.includes(cityId)) {
      return [node.id, ...groupsHolding(node.children, cityId)];
    }
  }
  return [];
}
