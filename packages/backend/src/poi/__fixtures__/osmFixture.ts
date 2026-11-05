import type { OsmFeature } from "../osmiumExtract.js";

/**
 * Hand-built 100-entry OSM fixture for exercising the tag filter spec.
 *
 * NOTE: the M7c plan calls for a real `.pbf` fixture at
 * `tests/fixtures/osm-fixture.osm.pbf`. Generating one requires the osmium-tool
 * binary, which is only present in CI (via the bundle-build workflow). For the
 * unit suite we exercise the same filter logic against this in-memory TS
 * fixture; the subprocess path (`runOsmiumExport`) is covered by a gated smoke
 * test in `osmiumExtract.test.ts` that only runs when the binary is present.
 * Fixture lives under `src/poi/__fixtures__/` so it falls inside the tsc
 * rootDir; move it to `tests/fixtures/` if backend tsconfig ever widens.
 *
 * Coverage targets per strict tier category:
 *   - transit_entrance: 10 matches, 5 excluded
 *   - named_junction:    6 matches, 4 excluded
 *   - public_building:  10 matches, 6 excluded (clinics, dorms, schools, ...)
 *   - named_square:      9 matches, 2 excluded (no name)
 *
 * Plus loose-tier fodder so tier switching is exercised.
 */

let idSeq = 0;
function f(tags: Record<string, string>, lat = 54.35, lon = 18.65): OsmFeature {
  idSeq += 1;
  return {
    id: String(idSeq),
    type: "node",
    lat,
    lon,
    tags,
  };
}

export const fixtureFeatures: OsmFeature[] = [
  // ───── strict.transit_entrance: 10 expected matches ─────
  f({ railway: "station", name: "Gdańsk Główny" }),
  f({ railway: "station", name: "Gdynia Główna" }),
  f({ railway: "halt", name: "Gdańsk Wrzeszcz" }),
  f({ railway: "halt", name: "Sopot Wyścigi" }),
  f({ railway: "tram_stop", name: "Plac Solidarności" }),
  f({ railway: "tram_stop", name: "Akademia Medyczna" }),
  f({ public_transport: "station", name: "Gdańsk Port Lotniczy" }),
  f({ public_transport: "station", name: "Sopot Centrum" }),
  f({ aerialway: "station", name: "Gondola Top" }),
  f({ amenity: "bus_station", name: "Dworzec PKS Gdańsk" }),

  // transit_entrance excluded (bus stop / platform / stop_position / no name)
  f({ highway: "bus_stop", name: "Przystanek 1" }),
  f({ public_transport: "platform", name: "Peron 2" }),
  f({ public_transport: "stop_position", name: "Zatrzymanie" }),
  f({ railway: "station" }), // no name
  f({ railway: "tram_stop" }), // tram stop without name

  // ───── strict.named_junction: 6 expected matches ─────
  f({ highway: "motorway_junction", name: "Węzeł Gdańsk Wschód" }),
  f({ highway: "motorway_junction", name: "Węzeł Gdańsk Południe" }),
  f({ highway: "motorway_junction", name: "Węzeł Rębiechowo" }),
  f({ junction: "yes", name: "Rondo Kiepury" }),
  f({ junction: "yes", name: "Rondo Mickiewicza" }),
  f({ junction: "yes", name: "Rondo Ofiar Katynia" }),
  f({ place: "square", name: "Targ Węglowy" }), // matches named_square, not named_junction
  f({ place: "square", name: "Targ Sienny" }),

  // named_junction excluded / ambiguous
  f({ highway: "motorway_junction" }), // no name
  f({ junction: "yes" }),
  f({ traffic_signals: "signal", name: "Sygnalizacja" }),
  f({ crossing: "uncontrolled", name: "Przejście" }),

  // ───── strict.public_building: 10 expected matches ─────
  f({ amenity: "hospital", name: "Uniwersyteckie Centrum Kliniczne" }),
  f({ amenity: "hospital", name: "Szpital Marynarki Wojennej" }),
  f({ amenity: "hospital", name: "Copernicus" }),
  f({ amenity: "university", name: "Uniwersytet Gdański" }),
  f({ amenity: "university", name: "Politechnika Gdańska" }),
  f({ amenity: "college", name: "Wyższa Szkoła Bankowa" }),
  f({ aeroway: "aerodrome", "aerodrome:type": "international", name: "Lech Wałęsa" }),
  f({ aeroway: "aerodrome", iata: "GDN", name: "Rębiechowo" }),
  f({ aeroway: "terminal", name: "Terminal T2" }),
  f({ aeroway: "terminal", name: "Terminal T1" }),

  // public_building excluded (exclusion list)
  f({ amenity: "hospital", name: "Pomoc", building: "residential" }), // residential overrides
  f({ amenity: "clinic", name: "Przychodnia" }),
  f({ amenity: "doctors", name: "Lekarze" }),
  f({ amenity: "pharmacy", name: "Apteka" }),
  f({ amenity: "school", name: "Szkoła Podstawowa 12" }),
  f({ amenity: "kindergarten", name: "Przedszkole 5" }),

  // ───── strict.named_square: 9 expected matches ─────
  // 7 from below (pedestrian+area, leisure=plaza) plus 2 place=square entries
  // above (Targ Węglowy, Targ Sienny) that match named_square, not
  // named_junction, because the categorize rule for named_junction requires
  // highway=motorway_junction or junction=yes.
  f({ highway: "pedestrian", area: "yes", name: "Ulica Długa" }),
  f({ highway: "pedestrian", area: "yes", name: "Długi Targ" }),
  f({ highway: "pedestrian", area: "yes", name: "Mariacka" }),
  f({ highway: "pedestrian", area: "yes", name: "Piwna" }),
  f({ leisure: "plaza", name: "Plaza Riviera" }),
  f({ leisure: "plaza", name: "Plaza Forum" }),
  f({ leisure: "plaza", name: "Plaza Galeria" }),

  // named_square excluded (no name / no area)
  f({ highway: "pedestrian", area: "yes" }),
  f({ leisure: "plaza" }),

  // ───── loose.named_bus_stop fodder (7 matches) ─────
  f({ highway: "bus_stop", name: "Przystanek Wrzeszcz" }),
  f({ highway: "bus_stop", name: "Przystanek Oliwa" }),
  f({ highway: "bus_stop", name: "Przystanek Brzeźno" }),
  f({ highway: "bus_stop", name: "Przystanek Stocznia" }),
  f({ highway: "bus_stop", name: "Przystanek Zaspa" }),
  f({ highway: "bus_stop", name: "Przystanek Przymorze" }),
  f({ highway: "bus_stop", name: "Przystanek Żabianka" }),

  // ───── loose.school (5 matches) ─────
  f({ amenity: "school", name: "SP 50" }),
  f({ amenity: "school", name: "LO I" }),
  f({ amenity: "school", name: "LO III" }),
  f({ amenity: "kindergarten", name: "Przedszkole 7" }),
  f({ amenity: "kindergarten", name: "Przedszkole 11" }),

  // ───── loose.tourism (5 matches, 3 excluded) ─────
  f({ tourism: "museum", name: "Muzeum II Wojny Światowej" }),
  f({ tourism: "museum", name: "ECS" }),
  f({ tourism: "attraction", name: "Żuraw" }),
  f({ tourism: "hotel", name: "Hotel Gdańsk" }),
  f({ tourism: "hostel", name: "Hostel Targ" }),
  f({ tourism: "viewpoint", name: "Wzgórze Pachołek" }), // excluded
  f({ tourism: "information", name: "Punkt Informacji" }), // excluded
  f({ tourism: "information", name: "Info Tourist" }), // excluded

  // ───── loose.retail (4 matches) ─────
  f({ shop: "mall", name: "Galeria Bałtycka" }),
  f({ shop: "mall", name: "Forum Gdańsk" }),
  f({ shop: "supermarket", name: "Biedronka" }),
  f({ shop: "supermarket", name: "Lidl" }),

  // ───── generic noise that should match nothing in either tier ─────
  f({ building: "house" }),
  f({ building: "residential", name: "Blok 12" }),
  f({ landuse: "residential" }),
  f({ natural: "tree" }),
  f({ natural: "water" }),
  f({ power: "pole" }),
  f({ barrier: "fence" }),
  f({ amenity: "bench" }),
  f({ amenity: "waste_basket" }),
  f({ highway: "residential", name: "Ulica Polna" }),
  f({ highway: "primary", name: "Aleja Grunwaldzka" }),
  f({ highway: "secondary", name: "Aleja Zwycięstwa" }),
  f({ highway: "footway" }),
  f({ highway: "cycleway" }),
  f({ waterway: "river", name: "Motława" }),
  f({ landuse: "forest" }),
  f({ landuse: "grass" }),
  f({ place: "suburb", name: "Oliwa" }),
  f({ place: "neighbourhood", name: "Zaspa" }),
  f({ amenity: "parking" }),
  f({ amenity: "post_box" }),
  f({ amenity: "fountain" }),
  f({ addr: "123" } as Record<string, string>),
  f({ man_made: "surveillance" }),
];

if (fixtureFeatures.length !== 100) {
  throw new Error(
    `osmFixture: expected 100 features, found ${fixtureFeatures.length}`
  );
}

/** Pre-computed expected match counts for assertions. */
export const fixtureExpectedStrictCounts = {
  transit_entrance: 10,
  named_junction: 6,
  public_building: 10,
  named_square: 9,
  culture: 2,
  mall: 2,
} as const;

export const fixtureExpectedLooseCounts = {
  // Note: strict-tier-excluded entries (bus stops, schools, kindergartens
  // named in the transit_entrance / public_building exclusion sections) ALSO
  // match the corresponding loose categories. That's correct: loose tier is a
  // separate supplement; museums and malls now belong to strict.
  named_bus_stop: 8,
  school: 4,
  kindergarten: 3,
  tourism: 3,
  retail: 2,
} as const;
