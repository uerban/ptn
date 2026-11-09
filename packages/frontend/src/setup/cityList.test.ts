import { describe, expect, it } from "vitest";
import type { CityConfig } from "../config/cities.ts";
import {
  CONTINENT_ABOVE_CITIES,
  FILTER_MIN_CITIES,
  GROUP_ABOVE_CITIES,
  buildCityList,
  continentOf,
  groupsHolding,
  regionNamer,
  type CityListInput,
  type CityNode,
} from "./cityList.ts";

const city = (id: string, name: string, countryCode?: string): CityConfig =>
  ({
    id,
    name,
    tz: "Europe/Vilnius",
    available: true,
    ...(countryCode ? { countryCode } : {}),
    center: { lat: 0, lon: 0 },
    bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
  }) as CityConfig;

const english = regionNamer("en");

function view(cities: readonly CityConfig[], overrides: Partial<CityListInput> = {}) {
  return buildCityList({
    cities,
    openableCount: cities.length,
    installedCityIds: new Set(),
    query: "",
    locale: "en",
    regionName: english,
    ...overrides,
  });
}

/** Compact outline: city names, groups as `Label[...]`, country subtext as `name/country`. */
function outline(nodes: readonly CityNode[]): string[] {
  return nodes.map((node) =>
    node.kind === "city"
      ? node.country
        ? `${node.city.name}/${node.country}`
        : node.city.name
      : `${node.label}[${outline(node.children).join(",")}]`,
  );
}

const baltic = [
  city("vilnius", "Vilnius", "LT"),
  city("kaunas", "Kaunas", "LT"),
  city("klaipeda", "Klaipėda", "LT"),
  city("riga", "Riga", "LV"),
  city("tallinn", "Tallinn", "EE"),
  city("tartu", "Tartu", "EE"),
  city("warsaw", "Warsaw", "PL"),
  city("krakow", "Kraków", "PL"),
  city("gdansk", "Gdańsk", "PL"),
  city("oslo", "Oslo", "NO"),
  city("unknown", "Atlantis"),
];

describe("city list view model", () => {
  it("lists a short catalog flat, in catalog order, with country subtext and no filter", () => {
    const cities = [city("vilnius", "Vilnius", "LT"), city("paris", "Paris", "FR"), city("x", "Nowhere")];
    const result = view(cities);
    expect(result.showFilter).toBe(false);
    expect(result.grouped).toBe(false);
    expect(outline(result.nodes)).toEqual(["Vilnius/Lithuania", "Paris/France", "Nowhere"]);
  });

  it("shows the filter from the threshold on, counting only openable cities", () => {
    const cities = baltic.slice(0, FILTER_MIN_CITIES);
    expect(view(cities).showFilter).toBe(true);
    expect(view(cities, { openableCount: FILTER_MIN_CITIES - 1 }).showFilter).toBe(false);
    // A query has no effect while the filter is hidden.
    expect(view(cities, { openableCount: 3, query: "riga" }).nodes).toHaveLength(cities.length);
  });

  it("groups by country only above the grouping threshold", () => {
    expect(view(baltic, { openableCount: GROUP_ABOVE_CITIES }).grouped).toBe(false);
    expect(view(baltic, { openableCount: GROUP_ABOVE_CITIES + 1 }).grouped).toBe(true);
  });

  it("collapses single-city countries to the city, labelled with its country", () => {
    const result = view(baltic);
    expect(outline(result.nodes)).toEqual([
      "Atlantis",
      "Estonia[Tallinn,Tartu]",
      "Lithuania[Kaunas,Klaipėda,Vilnius]",
      "Oslo/Norway",
      "Poland[Gdańsk,Kraków,Warsaw]",
      "Riga/Latvia",
    ]);
  });

  it("puts installed cities first within a group", () => {
    const result = view(baltic, { installedCityIds: new Set(["vilnius", "warsaw"]) });
    const lithuania = result.nodes.find((n) => n.kind === "group" && n.id === "country:LT");
    expect(outline([lithuania!])).toEqual(["Lithuania[Vilnius,Kaunas,Klaipėda]"]);
    const poland = result.nodes.find((n) => n.kind === "group" && n.id === "country:PL");
    expect(outline([poland!])).toEqual(["Poland[Warsaw,Gdańsk,Kraków]"]);
  });

  it("sorts by name in the UI locale", () => {
    const cities = [
      ...baltic,
      city("zagreb", "Zagreb", "HR"),
      city("split", "Split", "HR"),
    ];
    const names = (locale: string) =>
      view(cities, { locale, regionName: regionNamer(locale) }).nodes.map((n) =>
        n.kind === "city" ? n.city.name : n.label,
      );
    expect(names("en")).toEqual([
      "Atlantis",
      "Croatia",
      "Estonia",
      "Lithuania",
      "Oslo",
      "Poland",
      "Riga",
    ]);
    // Localized group names change the order: Lithuanian "Estija", "Kroatija", …
    const lt = names("lt");
    expect(lt.indexOf("Estija")).toBeLessThan(lt.indexOf("Kroatija"));
  });

  it("adds a continent level only above its threshold, collapsing single members", () => {
    const many: CityConfig[] = [...baltic];
    for (let i = 0; many.length <= CONTINENT_ABOVE_CITIES; i++) {
      many.push(city(`de${i}`, `Stadt ${i}`, "DE"));
    }
    many.push(city("tbilisi", "Tbilisi", "GE"));
    many.push(city("sydney", "Sydney", "AU"), city("perth", "Perth", "AU"));
    expect(view(many, { openableCount: CONTINENT_ABOVE_CITIES }).nodes.some((n) => n.kind === "group" && n.label === "Europe")).toBe(false);

    const result = view(many);
    const top = outline(result.nodes).map((entry) => entry.split("[")[0]);
    // Asia holds one city, Oceania one country: both collapse a level.
    expect(top).toEqual(["Atlantis", "Australia", "Europe", "Tbilisi/Georgia"]);
    const europe = result.nodes.find((n) => n.kind === "group" && n.id === "continent:150");
    expect(europe?.kind === "group" && outline(europe.children).map((e) => e.split("[")[0])).toEqual([
      "Estonia",
      "Germany",
      "Lithuania",
      "Oslo/Norway",
      "Poland",
      "Riga/Latvia",
    ]);
  });

  it("flattens matches of any query, with country subtext", () => {
    const result = view(baltic, { query: "  TA " });
    expect(result.grouped).toBe(false);
    expect(outline(result.nodes)).toEqual(["Tallinn/Estonia", "Tartu/Estonia"]);
    expect(outline(view(baltic, { query: "poland" }).nodes)).toEqual([
      "Warsaw/Poland",
      "Kraków/Poland",
      "Gdańsk/Poland",
    ]);
  });

  it("lists only the given cities, flat", () => {
    const result = view(baltic, { onlyCityIds: new Set(["riga", "vilnius"]) });
    expect(outline(result.nodes)).toEqual(["Vilnius/Lithuania", "Riga/Latvia"]);
  });

  it("finds the groups holding a city", () => {
    const nodes = view(baltic).nodes;
    expect(groupsHolding(nodes, "kaunas")).toEqual(["country:LT"]);
    expect(groupsHolding(nodes, "riga")).toEqual([]);
    expect(groupsHolding(nodes, null)).toEqual([]);
  });

  it("maps countries to continents and tolerates unknown codes", () => {
    expect(continentOf("lt")).toBe("150");
    expect(continentOf("JP")).toBe("142");
    expect(continentOf("ZZ")).toBeNull();
    expect(english("not a region")).toBeNull();
    expect(english("150")).toBe("Europe");
  });
});
