import { describe, it, expect, vi } from "vitest";
import {
  nearestSegmentTangent,
  deriveSide,
  pairKey,
  deriveStopHints,
  deriveStopHintsAsync,
  polylinesServingStop,
} from "../../src/components/Map/cardBearing.ts";

describe("polylinesServingStop", () => {
  it("keeps only direction shapes whose pattern serves the physical stop", () => {
    const outbound = [{ lat: 54.7, lon: 25.2 }, { lat: 54.7, lon: 25.3 }];
    const inbound = [{ lat: 54.71, lon: 25.3 }, { lat: 54.71, lon: 25.2 }];
    const patterns = [
      { stopIds: new Set(["roadside-out", "terminus"]), polyline: outbound },
      { stopIds: new Set(["roadside-in", "terminus"]), polyline: inbound },
    ];

    expect(polylinesServingStop("roadside-out", patterns)).toEqual([outbound]);
    expect(polylinesServingStop("roadside-in", patterns)).toEqual([inbound]);
    expect(polylinesServingStop("terminus", patterns)).toEqual([outbound, inbound]);
  });
});

// ── nearestSegmentTangent ────────────────────────────────────────────────────

describe("nearestSegmentTangent", () => {
  it("returns an eastward unit travel dir for an east-west polyline north of the stop", () => {
    const stop = { lat: 54.6872, lon: 25.2797 };
    // A polyline running west→east, ~50 m north of the stop.
    const north = stop.lat + 0.00045; // ~50 m
    const polyline = [
      { lat: north, lon: stop.lon - 0.002 },
      { lat: north, lon: stop.lon + 0.002 },
    ];
    const t = nearestSegmentTangent(stop, [polyline]);
    expect(t).not.toBeNull();
    expect(t!.travelDir.x).toBeGreaterThan(0.9);
    expect(Math.abs(t!.travelDir.y)).toBeLessThan(0.1);
    // bearing = atan2(y, x): due east ≈ 0 rad.
    expect(Math.abs(t!.bearingRad)).toBeLessThan(0.1);
    expect(t!.distanceM).toBeGreaterThan(45);
    expect(t!.distanceM).toBeLessThan(55);
    // The shape is north of the stop, so shape→stop points south.
    expect(t!.shapeToStop!.y).toBeLessThan(-0.9);
  });

  it("preserves GTFS travel direction (east→west polyline gives a westward dir)", () => {
    const stop = { lat: 54.6872, lon: 25.2797 };
    const north = stop.lat + 0.00045;
    const polyline = [
      { lat: north, lon: stop.lon + 0.002 },
      { lat: north, lon: stop.lon - 0.002 },
    ];
    const t = nearestSegmentTangent(stop, [polyline]);
    expect(t).not.toBeNull();
    expect(t!.travelDir.x).toBeLessThan(-0.9);
  });

  it("returns null when no polyline has >= 2 points", () => {
    const stop = { lat: 54.6872, lon: 25.2797 };
    expect(nearestSegmentTangent(stop, [])).toBeNull();
    expect(nearestSegmentTangent(stop, [[{ lat: 54.6872, lon: 25.2797 }]])).toBeNull();
    expect(nearestSegmentTangent(stop, [[]])).toBeNull();
  });

  it("chooses the nearest segment of a curved 3-point polyline", () => {
    const stop = { lat: 0, lon: 0 };
    // An L-shaped polyline. Leg A (first→second) runs north, ~111 m WEST of the
    // stop (lon -0.001), so its nearest approach is ~111 m. Leg B (second→third)
    // runs east, passing ~11 m north of the stop (lat 0.0001) right across the
    // stop's longitude — its nearest approach is ~11 m. Leg B wins → the chosen
    // tangent points east (+x), distinguishing "nearest segment" from "first".
    const polyline = [
      { lat: -0.001, lon: -0.001 },
      { lat: 0.0001, lon: -0.001 },
      { lat: 0.0001, lon: 0.001 },
    ];
    const t = nearestSegmentTangent(stop, [polyline]);
    expect(t).not.toBeNull();
    // Nearest segment is the second one (running east): unit ≈ {1, 0}.
    expect(t!.travelDir.x).toBeGreaterThan(0.9);
    expect(Math.abs(t!.travelDir.y)).toBeLessThan(0.1);
  });
});

// ── deriveSide ───────────────────────────────────────────────────────────────

describe("deriveSide", () => {
  it("(a) returns the unit parentVec when present", () => {
    const side = deriveSide({
      travelDir: { x: 1, y: 0 },
      dirsAgree: false,
      parentVec: { x: 0, y: 3 }, // not unit — must be normalised
    });
    expect(side).not.toBeNull();
    expect(side!.y).toBeGreaterThan(0.9);
    expect(Math.abs(side!.x)).toBeLessThan(0.1);
    // unit length
    expect(Math.hypot(side!.x, side!.y)).toBeCloseTo(1, 6);
  });

  it("(b) returns the right-hand normal of travel when dirs agree (east → south)", () => {
    const side = deriveSide({ travelDir: { x: 1, y: 0 }, dirsAgree: true });
    expect(side).not.toBeNull();
    // right of due-east travel is south: { x: 0, y: -1 }.
    expect(side!.y).toBeLessThan(-0.9);
    expect(Math.abs(side!.x)).toBeLessThan(0.1);
  });

  it("(c) returns null when dirs disagree and no parentVec", () => {
    expect(deriveSide({ travelDir: { x: 1, y: 0 }, dirsAgree: false })).toBeNull();
  });

  it("parentVec takes priority over dirsAgree=false", () => {
    const side = deriveSide({
      travelDir: { x: 1, y: 0 },
      dirsAgree: false,
      parentVec: { x: 0, y: 1 },
    });
    expect(side).not.toBeNull();
    expect(side!.y).toBeGreaterThan(0.9);
  });
});

// ── pairKey ──────────────────────────────────────────────────────────────────

describe("pairKey", () => {
  it("is equal for identical names", () => {
    expect(pairKey("Stotis")).toBe(pairKey("Stotis"));
  });

  it("strips parenthesised direction tokens so platforms group", () => {
    expect(pairKey("Katedra (1)")).toBe(pairKey("Katedra (2)"));
  });

  it("strips a trailing number token", () => {
    expect(pairKey("Stop 01")).toBe(pairKey("Stop 02"));
  });

  it("differs for genuinely different names", () => {
    expect(pairKey("Stotis")).not.toBe(pairKey("Katedra"));
  });

  it("is case- and whitespace-insensitive", () => {
    expect(pairKey("  STOTIS  ")).toBe(pairKey("stotis"));
    expect(pairKey("Vilniaus  Gatve")).toBe(pairKey("vilniaus gatve"));
  });

  it("strips a bracketed suffix", () => {
    expect(pairKey("Centras [A]")).toBe(pairKey("Centras [B]"));
  });
});

// ── deriveStopHints ──────────────────────────────────────────────────────────

describe("deriveStopHints", () => {
  it("falls back to a Stage-1 stop when no shape covers it", () => {
    const stops = [
      { id: "s1", name: "Stotis", location: { lat: 54.6872, lon: 25.2797 } },
    ];
    const hints = deriveStopHints(stops, new Map());
    const h = hints.get("s1");
    expect(h).toBeDefined();
    expect(h!.side).toBeNull();
  });

  it("splits a facing same-name pair to opposite curb sides", () => {
    // One east-west road; two platforms with the same name and parent station,
    // one ~50 m north of the road and one ~50 m south.
    const lat0 = 54.6872;
    const lon0 = 25.2797;
    const roadLat = lat0;
    const polyline = [
      { lat: roadLat, lon: lon0 - 0.003 },
      { lat: roadLat, lon: lon0 + 0.003 },
    ];
    const northStop = {
      id: "n",
      name: "Stotis (1)",
      location: { lat: roadLat + 0.00045, lon: lon0 },
      parentStationId: "P",
    };
    const southStop = {
      id: "s",
      name: "Stotis (2)",
      location: { lat: roadLat - 0.00045, lon: lon0 },
      parentStationId: "P",
    };
    const shapes = new Map([
      ["n", [polyline]],
      ["s", [polyline]],
    ]);
    const hints = deriveStopHints([northStop, southStop], shapes);
    const hn = hints.get("n");
    const hs = hints.get("s");
    expect(hn).toBeDefined();
    expect(hs).toBeDefined();
    // Both got a derived side from the coherent shape-to-stop normal.
    expect(hn!.side).not.toBeNull();
    expect(hs!.side).not.toBeNull();
    // Opposite y signs: north platform's side points north, south points south.
    expect(Math.sign(hn!.side!.y)).toBe(-Math.sign(hs!.side!.y));
    expect(hn!.side!.y).toBeGreaterThan(0); // away from the southern sibling
    expect(hs!.side!.y).toBeLessThan(0); // away from the northern sibling
  });

  it("does not treat a three-platform interchange as an opposite-curb pair", () => {
    const polyline = [
      { lat: 54.7, lon: 25.2 },
      { lat: 54.7, lon: 25.3 },
    ];
    const stops = [
      { id: "a", name: "Šeškinės kalvos", location: { lat: 54.7000, lon: 25.2500 } },
      { id: "b", name: "Šeškinės kalvos", location: { lat: 54.7002, lon: 25.2500 } },
      { id: "c", name: "Šeškinės kalvos", location: { lat: 54.7004, lon: 25.2500 } },
    ];
    const shapes = new Map(stops.map((stop) => [stop.id, [polyline]]));
    const hints = deriveStopHints(stops, shapes);

    expect(stops.every((stop) => hints.get(stop.id)?.side !== null)).toBe(true);
  });

  it("does not pair unparented same-name stops more than 150 m apart", () => {
    const stops = [
      { id: "near", name: "Centras", location: { lat: 54.7000, lon: 25.2500 } },
      { id: "far", name: "Centras", location: { lat: 54.7100, lon: 25.2500 } },
    ];
    const shapes = new Map(stops.map((stop) => [stop.id, [[
      { lat: stop.location.lat, lon: stop.location.lon - 0.002 },
      { lat: stop.location.lat, lon: stop.location.lon + 0.002 },
    ]]]));
    const hints = deriveStopHints(stops, shapes);

    // Both independently use the eastbound RHD normal. An accidental pair
    // would point them away from one another instead.
    expect(hints.get("near")?.side?.y).toBeLessThan(0);
    expect(hints.get("far")?.side?.y).toBeLessThan(0);
  });

  it("uses the RHD right-hand side for an unpaired stop on an agreeing road", () => {
    const stop = {
      id: "u",
      name: "Lone",
      location: { lat: 54.6872, lon: 25.2797 },
    };
    const north = stop.location.lat + 0.00045;
    const polyline = [
      { lat: north, lon: stop.location.lon - 0.002 },
      { lat: north, lon: stop.location.lon + 0.002 },
    ];
    const hints = deriveStopHints([stop], new Map([["u", [polyline]]]));
    const h = hints.get("u");
    expect(h).toBeDefined();
    // East travel, agrees with itself → right-hand normal = south.
    expect(h!.side).not.toBeNull();
    expect(h!.side!.y).toBeLessThan(-0.9);
  });

  it("places same-direction stops on their physical sides of a road shape", () => {
    const roadLon = 25.2797;
    const polyline = [
      { lat: 54.686, lon: roadLon },
      { lat: 54.689, lon: roadLon },
    ];
    const west = {
      id: "west",
      name: "West platform",
      location: { lat: 54.6872, lon: roadLon - 0.0002 },
    };
    const east = {
      id: "east",
      name: "East platform",
      location: { lat: 54.6872, lon: roadLon + 0.0002 },
    };
    const hints = deriveStopHints(
      [west, east],
      new Map([[west.id, [polyline]], [east.id, [polyline]]]),
    );

    // Northbound RHD alone would point both east. Shape→stop geometry keeps
    // each card on the physical curb containing its stop dot.
    expect(hints.get(west.id)?.side?.x).toBeLessThan(-0.9);
    expect(hints.get(east.id)?.side?.x).toBeGreaterThan(0.9);
  });

  it("rejects sibling geometry that runs along the road tangent", () => {
    const roadLon = 25.2797;
    const polyline = [
      { lat: 54.686, lon: roadLon },
      { lat: 54.689, lon: roadLon },
    ];
    const south = {
      id: "south",
      name: "Longitudinal pair",
      location: { lat: 54.6870, lon: roadLon },
      parentStationId: "P",
    };
    const north = {
      id: "north",
      name: "Longitudinal pair",
      location: { lat: 54.6874, lon: roadLon },
      parentStationId: "P",
    };
    const hints = deriveStopHints(
      [south, north],
      new Map([[south.id, [polyline]], [north.id, [polyline]]]),
    );

    // Both fall back to right-of-northbound travel (east), rather than being
    // pushed north/south away from an along-road sibling.
    expect(hints.get(south.id)?.side?.x).toBeGreaterThan(0.9);
    expect(hints.get(north.id)?.side?.x).toBeGreaterThan(0.9);
  });
});


describe("incremental stop hints", () => {
  const stops = [
    {id: "a", name: "Pair", location: {lat: 54.7, lon: 25.2}},
    {id: "b", name: "Pair", location: {lat: 54.7001, lon: 25.2}},
    {id: "c", name: "Other", location: {lat: 54.71, lon: 25.21}},
  ];
  const shapes = new Map(stops.map(stop => [stop.id, [[
    {lat: 54.70005, lon: 25.19}, {lat: 54.70005, lon: 25.22},
  ]]]));

  it("preserves full physical-group geometry while yielding to pending work", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock += 5);
    try {
      let yielded = false;
      setTimeout(() => { yielded = true; }, 0);
      const result = await deriveStopHintsAsync(stops, shapes, new AbortController().signal);
      expect(yielded).toBe(true);
      expect(result).toEqual(deriveStopHints(stops, shapes));
    } finally { now.mockRestore(); }
  });

  it("cancels a stale city between geometry batches without returning partial hints", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock += 5);
    const abort = new AbortController();
    try {
      setTimeout(() => abort.abort(), 0);
      await expect(deriveStopHintsAsync(stops, shapes, abort.signal)).rejects.toMatchObject({name: "AbortError"});
      await expect(deriveStopHintsAsync(stops, shapes, abort.signal)).rejects.toMatchObject({name: "AbortError"});
    } finally { now.mockRestore(); }
  });
});
