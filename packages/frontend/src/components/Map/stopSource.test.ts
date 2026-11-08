import {expect, it, vi} from "vitest";
import type {StopWithLines, LabelAnchor} from "@pt/shared";
import {StopSourceCache, rememberStopSource, updateStopSource} from "./stopSource.ts";
const stop: StopWithLines = {id: "s", name: "Stop", location: {lat: 1, lon: 2}, lastSeen: 1,
  lines: [{routeId: "route", shortName: "1", mode: "BUS"}]};

it("keeps the source and worker untouched for badge-only updates", () => {
  const cache = new StopSourceCache(), overrides = new Map<string, LabelAnchor>();
  const initial = cache.build([stop], [], [], overrides);
  const source = {setData: vi.fn()};
  rememberStopSource(source, initial);
  const changed = cache.build([{...stop, lastSeen: 2, lines: []}], [], [], overrides);
  expect(changed).toBe(initial);
  expect(updateStopSource(source, changed)).toBe(false);
  expect(source.setData).not.toHaveBeenCalled();
});

it("updates actual source properties, membership, overrides and fading exits", () => {
  const cache = new StopSourceCache(), overrides = new Map<string, LabelAnchor>();
  let previous = cache.build([stop], [], [], overrides);
  for (const changed of [
    {...stop, name: "Renamed"}, {...stop, location: {lat: 3, lon: 4}}, {...stop, labelAnchor: "top-left" as const},
  ]) {
    const next = cache.build([changed], [], [], overrides);
    expect(next).not.toBe(previous);
    previous = next;
  }
  const active = cache.build([stop], [], [], overrides);
  expect(cache.build([], [stop], [], overrides)).toBe(active);
  expect(cache.build([], [], [], overrides).features).toEqual([]);
  overrides.set(stop.id, "bottom-left");
  expect(cache.build([stop], [], [], overrides).features[0].properties?.labelAnchor).toBe("bottom-left");
});

it("publishes to a replaced style source and includes changed city markers", () => {
  const cache = new StopSourceCache();
  const cities: GeoJSON.Feature<GeoJSON.Point>[] = [{type: "Feature", geometry: {type: "Point", coordinates: [2, 1]}, properties: {id: "city:a", name: "A"}}];
  const first = cache.build([stop], [], cities, new Map());
  const old = {setData: vi.fn()}, replacement = {setData: vi.fn()};
  rememberStopSource(old, first);
  expect(updateStopSource(replacement, first)).toBe(true);
  expect(updateStopSource(replacement, first)).toBe(false);
  const changed = cache.build([stop], [], [{...cities[0], properties: {id: "city:b", name: "B"}}], new Map());
  expect(updateStopSource(replacement, changed)).toBe(true);
  expect(replacement.setData).toHaveBeenCalledTimes(2);
});
