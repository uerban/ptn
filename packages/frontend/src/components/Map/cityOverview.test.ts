import { describe, expect, test } from "vitest";
import { ZOOM_DOTS_MIN, ZOOM_OVERVIEW_MAX } from "@pt/shared/constants";
import { cityOverviewFeatures, IS_CITY, IS_STOP } from "./cityOverview.ts";

const cities = [
  { id: "vilnius", name: "Vilnius", center: { lat: 54.6872, lon: 25.2797 } },
  { id: "tbilisi", name: "Tbilisi", center: { lat: 41.7151, lon: 44.8271 } },
];

describe("city overview", () => {
  test("one static marker per covered city, at its centre", () => {
    const features = cityOverviewFeatures(cities);
    expect(features).toHaveLength(2);
    expect(features[1]).toMatchObject({
      geometry: { type: "Point", coordinates: [44.8271, 41.7151] },
      properties: { id: "city:tbilisi", kind: "city", cityId: "tbilisi", name: "Tbilisi" },
    });
  });

  // Stop aggregates covered the city users were navigating. Overview markers
  // only appear far out, and stops take over exactly where they stop. Below
  // zoom 10 a phone shows a metro area as one blob of dots.
  test("stops replace city markers at one zoom, far out", () => {
    expect(ZOOM_OVERVIEW_MAX).toBe(ZOOM_DOTS_MIN);
    expect(ZOOM_OVERVIEW_MAX).toBe(10);
  });

  test("city and stop filters split the shared source", () => {
    expect(IS_CITY).toEqual(["==", ["get", "kind"], "city"]);
    expect(IS_STOP).toEqual(["!=", ["get", "kind"], "city"]);
  });
});

test("marker sizes grow gently with coverage and stay bounded", async () => {
  const {cityMarkerRadius} = await import("./cityOverview.ts");
  const small = cityMarkerRadius({...cities[0], bbox: {minLat: 54.6, maxLat: 54.7, minLon: 25.2, maxLon: 25.3}});
  const big = cityMarkerRadius({...cities[0], bbox: {minLat: 54, maxLat: 55, minLon: 25, maxLon: 26}});
  expect(big).toBeGreaterThan(small);
  expect(small).toBeGreaterThanOrEqual(6);
  expect(big).toBeLessThanOrEqual(16);
});
