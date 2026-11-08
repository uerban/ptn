import {expect, it} from "vitest";
import type {StopWithLines} from "@pt/shared";
import {StopViewportIndex} from "./stopViewportIndex.ts";
const stop = (id: string, lon: number, lat = 1): StopWithLines => ({id, name: id, location: {lon, lat}, lastSeen: 1});

it("matches inclusive viewport filtering and preserves input order", () => {
  const stops = Array.from({length: 1200}, (_, i) => stop(String(i), (i * 17) % 360 - 180, (i * 11) % 160 - 80));
  const index = new StopViewportIndex(stops);
  for (const bounds of [
    {west: -20, east: 40, south: -10, north: 30},
    {west: -180, east: 179, south: -80, north: 79},
    {west: 10, east: 10, south: -80, north: 80},
    {west: 50, east: 70, south: 20, north: 20},
  ]) {
    expect(index.query(bounds)).toEqual(stops.filter(({location: p}) =>
      p.lon >= bounds.west && p.lon <= bounds.east && p.lat >= bounds.south && p.lat <= bounds.north).map(stop => stop.id));
  }
});

it("handles antimeridian viewports, repeated worlds and full-world bounds", () => {
  const stops = [stop("east", 175), stop("west", -175), stop("middle", 0), stop("copy", -160), stop("edge", 180)];
  const index = new StopViewportIndex(stops);
  expect(index.query({west: 170, east: -170, south: 0, north: 2})).toEqual(["east", "west", "edge"]);
  expect(index.query({west: 170, east: 190, south: 0, north: 2})).toEqual(["east", "west", "edge"]);
  expect(index.query({west: 195, east: 205, south: 0, north: 2})).toEqual(["copy"]);
  expect(index.query({west: -540, east: 540, south: 0, north: 2})).toEqual(stops.map(stop => stop.id));
});

it("returns no invalid coordinate candidates and does not retain badge snapshots", () => {
  const index = new StopViewportIndex([stop("valid", 25), stop("invalid", NaN), stop("invalid-lat", 25, Infinity)]);
  expect(index.query({west: 20, east: 30, south: 0, north: 2})).toEqual(["valid"]);
  expect(index.query({west: NaN, east: 30, south: 0, north: 2})).toEqual([]);
  expect(index.query({west: 20, east: 30, south: 2, north: 0})).toEqual([]);
});
