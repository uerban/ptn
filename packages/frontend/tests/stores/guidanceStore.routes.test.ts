import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Itinerary } from "@pt/shared";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { polledRoutes } from "../helpers/rtPollerRoutes.ts";

const walk: Itinerary = {
  legs: [{
    mode: "WALK",
    from: { name: "Origin", location: { lat: 54.68, lon: 25.25 } },
    to: { name: "Destination", location: { lat: 54.69, lon: 25.26 } },
    departureTime: "2026-11-13T10:00:00Z",
    arrivalTime: "2026-11-13T10:10:00Z",
    durationSeconds: 600,
    distanceMeters: 800,
  }],
  departureTime: "2026-11-13T10:00:00Z",
  arrivalTime: "2026-11-13T10:10:00Z",
  durationSeconds: 600,
  transfers: 0,
  walkingDistanceMeters: 800,
};
const transit = (routeId: string): Itinerary => ({
  ...walk,
  legs: [{ ...walk.legs[0]!, mode: "BUS", routeId, tripId: `${routeId}-trip` }],
  walkingDistanceMeters: 0,
});
const update = (routeId: string) => ({
  routeId,
  trips: [{ tripId: `${routeId}-trip`, delaySeconds: 60, cancelled: false }],
  generatedAt: Date.now(),
});

beforeEach(() => {
  useGuidanceStore.getState().reset();
  // Exercise real subscription bookkeeping without starting network requests.
  vi.spyOn(useRtStore.getState().poller, "start").mockImplementation(() => {});
});
afterEach(() => {
  useGuidanceStore.getState().reset();
  vi.restoreAllMocks();
});

it("releases obsolete RT routes when a transit navigation is replaced by walking", () => {
  useGuidanceStore.getState().startNavigation(transit("old"));
  useRtStore.getState().applyUpdate(update("old"));
  expect(polledRoutes()).toEqual(["old"]);
  expect(useRtStore.getState().getTripDelay("old-trip")).not.toBeNull();
  const stop = vi.spyOn(useRtStore.getState().poller, "stop");
  useGuidanceStore.getState().startNavigation(walk);
  expect(polledRoutes()).toEqual([]);
  expect(useRtStore.getState().updates.size).toBe(0);
  expect(useRtStore.getState().getTripDelay("old-trip")).toBeNull();
  expect(stop).toHaveBeenCalled();
  expect(useGuidanceStore.getState()).toMatchObject({ phase: "navigating", itinerary: walk });
});

it("preserves another surface's holds, then releases them without an old guidance hold", () => {
  const release = useRtStore.getState().retainRoutes(["old", "preview"]);
  try {
    useGuidanceStore.getState().startNavigation(transit("old"));
    useRtStore.getState().applyUpdate(update("old"));
    useRtStore.getState().applyUpdate(update("preview"));
    useGuidanceStore.getState().startNavigation(walk);
    expect(polledRoutes()).toEqual(["old", "preview"]);
    expect(useRtStore.getState().getTripDelay("old-trip")).not.toBeNull();
    expect(useRtStore.getState().getTripDelay("preview-trip")).not.toBeNull();
    release();
    expect(polledRoutes()).toEqual([]);
    expect(useRtStore.getState().updates.size).toBe(0);
  } finally {
    release();
  }
});

it("still replaces an old transit route with the new trip's route", () => {
  useGuidanceStore.getState().startNavigation(transit("old"));
  useRtStore.getState().applyUpdate(update("old"));
  useGuidanceStore.getState().startNavigation(transit("new"));
  expect(polledRoutes()).toEqual(["new"]);
  expect(useRtStore.getState().getTripDelay("old-trip")).toBeNull();
  useRtStore.getState().applyUpdate(update("new"));
  expect(useRtStore.getState().getTripDelay("new-trip")).not.toBeNull();
});
