import { describe, expect, it } from "vitest";
import type { GbfsStation } from "../../services/gbfs/types.ts";
import {
  BIKE_CIRCLE_COLOR,
  BIKE_LABEL_COLOR,
  BUCKET_COLORS,
  bucketFor,
  stationsToFeatures,
} from "./bikeShareFeatures.ts";

/** Baseline healthy station; override per case. */
function station(overrides: Partial<GbfsStation> = {}): GbfsStation {
  return {
    stationId: "42",
    name: "Katedros a.",
    lat: 54.6858,
    lon: 25.2871,
    address: "Katedros a. 1",
    capacity: 20,
    bikesAvailable: 5,
    docksAvailable: 15,
    isInstalled: true,
    isRenting: true,
    isReturning: true,
    lastReported: 1_752_700_000,
    ...overrides,
  };
}

describe("bucketFor", () => {
  it("buckets green at bikesAvailable >= 3", () => {
    expect(bucketFor(station({ bikesAvailable: 3 }))).toBe("green");
    expect(bucketFor(station({ bikesAvailable: 12 }))).toBe("green");
  });

  it("buckets amber at bikesAvailable 1-2", () => {
    expect(bucketFor(station({ bikesAvailable: 1 }))).toBe("amber");
    expect(bucketFor(station({ bikesAvailable: 2 }))).toBe("amber");
  });

  it("buckets red at bikesAvailable 0", () => {
    expect(bucketFor(station({ bikesAvailable: 0 }))).toBe("red");
  });

  it("buckets grey when counts are null (status unknown)", () => {
    expect(
      bucketFor(station({ bikesAvailable: null, docksAvailable: null })),
    ).toBe("grey");
  });

  it("buckets grey when not installed, regardless of count", () => {
    expect(bucketFor(station({ isInstalled: false, bikesAvailable: 7 }))).toBe(
      "grey",
    );
  });

  it("buckets grey when not renting, regardless of count", () => {
    expect(bucketFor(station({ isRenting: false, bikesAvailable: 1 }))).toBe(
      "grey",
    );
  });

  // Precedence pin: the grey conditions are evaluated BEFORE the count
  // tiers — a non-renting station with a green-tier count must NOT go green.
  it("grey precedence beats the green tier (isRenting:false, bikes >= 3)", () => {
    expect(bucketFor(station({ isRenting: false, bikesAvailable: 9 }))).toBe(
      "grey",
    );
  });
});

describe("stationsToFeatures", () => {
  it("builds a Point FeatureCollection in station order", () => {
    const fc = stationsToFeatures([
      station({ stationId: "a", lat: 54.7, lon: 25.3 }),
      station({ stationId: "b", lat: 54.6, lon: 25.2 }),
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry).toEqual({
      type: "Point",
      coordinates: [25.3, 54.7], // GeoJSON order: [lon, lat]
    });
    expect(fc.features[1].properties.stationId).toBe("b");
  });

  it("returns an empty collection for no stations", () => {
    expect(stationsToFeatures([]).features).toEqual([]);
  });

  it("carries stationId as feature id and property for tap lookup", () => {
    const [f] = stationsToFeatures([station({ stationId: "st-7" })]).features;
    expect(f.id).toBe("st-7");
    expect(f.properties.stationId).toBe("st-7");
    expect(f.properties.name).toBe("Katedros a.");
  });

  it("labels the count only when bikesAvailable is non-null", () => {
    const fc = stationsToFeatures([
      station({ stationId: "live", bikesAvailable: 4 }),
      station({ stationId: "zero", bikesAvailable: 0 }),
      station({
        stationId: "unknown",
        bikesAvailable: null,
        docksAvailable: null,
      }),
    ]);
    const byId = new Map(fc.features.map((f) => [f.properties.stationId, f]));
    expect(byId.get("live")?.properties.label).toBe("4");
    // 0 is a real count — labelled, never blanked into "unknown".
    expect(byId.get("zero")?.properties.label).toBe("0");
    // null ⇒ status unknown ⇒ no label (empty string renders nothing).
    expect(byId.get("unknown")?.properties.label).toBe("");
  });

  it("stamps the color bucket per station, grey checks first", () => {
    const fc = stationsToFeatures([
      station({ stationId: "g", bikesAvailable: 3 }),
      station({ stationId: "a", bikesAvailable: 2 }),
      station({ stationId: "r", bikesAvailable: 0 }),
      station({ stationId: "off", bikesAvailable: 8, isRenting: false }),
      station({
        stationId: "cached",
        bikesAvailable: null,
        docksAvailable: null,
      }),
    ]);
    const buckets = Object.fromEntries(
      fc.features.map((f) => [f.properties.stationId, f.properties.bucket]),
    );
    expect(buckets).toEqual({
      g: "green",
      a: "amber",
      r: "red",
      off: "grey",
      cached: "grey",
    });
  });
});

describe("BIKE_CIRCLE_COLOR", () => {
  it("is a data-driven match over the bucket property covering every bucket", () => {
    // ExpressionSpecification is a wide tuple union; widen for inspection.
    const [op, input, ...rest] = BIKE_CIRCLE_COLOR as unknown[];
    expect(op).toBe("match");
    expect(input).toEqual(["get", "bucket"]);
    const fallback = rest[rest.length - 1];
    expect(fallback).toBe(BUCKET_COLORS.grey);
    // Every non-fallback bucket appears as a branch with its color.
    for (const bucket of ["green", "amber", "red"] as const) {
      const i = rest.indexOf(bucket);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(rest[i + 1]).toBe(BUCKET_COLORS[bucket]);
    }
  });
});

describe("BIKE_LABEL_COLOR", () => {
  it("uses white only on red and dark ink on the lighter buckets", () => {
    expect(BIKE_LABEL_COLOR).toEqual([
      "match",
      ["get", "bucket"],
      "red",
      "#ffffff",
      "#111827",
    ]);
  });
});
