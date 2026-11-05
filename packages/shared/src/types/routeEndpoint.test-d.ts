// Type-level tests for BaseEndpoint / RecentRef / SavedRef.
//
// These tests exist to lock the invariant: RecentRef.base and SavedRef.base
// accept only BaseEndpoint (a flat union), never another RecentRef or SavedRef.
// Recursive wrapping must fail to typecheck.
//
// `tsd` is not present in this workspace; we use built-in `@ts-expect-error`
// comments, which achieve the same check — the compiler errors if the marked
// line does NOT produce a type error.

import type { BaseEndpoint, RecentRef, SavedRef } from "./routeEndpoint.js";

// Positive: valid BaseEndpoint variants compile.
const stopEp: BaseEndpoint = {
  kind: "stop",
  stopId: "s1",
  name: "A",
  lat: 0,
  lon: 0,
};
const mapEp: BaseEndpoint = { kind: "mappoint", lat: 0, lon: 0 };
const geocodedEp: BaseEndpoint = {
  kind: "geocoded",
  lat: 0,
  lon: 0,
  label: "Somewhere",
  provider: "bundled",
  confidence: 0.9,
};
const stopGroupEp: BaseEndpoint = {
  kind: "stopGroup",
  stopIds: ["s1", "s2"],
  lat: 0,
  lon: 0,
  label: "Twin Stops",
};

// Positive: valid RecentRef wrapping a BaseEndpoint.
const recentStop: RecentRef = {
  kind: "recent",
  base: stopEp,
  usedAt: 0,
  usedAsOrigin: true,
};

// Positive: valid SavedRef wrapping a BaseEndpoint.
const savedMap: SavedRef = {
  kind: "saved",
  base: mapEp,
  alias: "home",
  savedAt: 0,
  encrypted: false,
};

// Negative: recent-of-recent must NOT compile.
const recentOfRecent: RecentRef = {
  kind: "recent",
  // @ts-expect-error - base must be a BaseEndpoint, not another RecentRef.
  base: recentStop,
  usedAt: 0,
  usedAsOrigin: true,
};

// Negative: saved-of-saved must NOT compile.
const savedOfSaved: SavedRef = {
  kind: "saved",
  // @ts-expect-error - base must be a BaseEndpoint, not another SavedRef.
  base: savedMap,
  alias: "x",
  savedAt: 0,
  encrypted: false,
};

// Negative: saved-of-recent must NOT compile.
const savedOfRecent: SavedRef = {
  kind: "saved",
  // @ts-expect-error - base must be a BaseEndpoint, not a RecentRef.
  base: recentStop,
  alias: "x",
  savedAt: 0,
  encrypted: false,
};

// Keep referenced so unused-local checks don't fire.
export type _ = [
  typeof stopGroupEp,
  typeof stopEp,
  typeof mapEp,
  typeof geocodedEp,
  typeof recentOfRecent,
  typeof savedOfSaved,
  typeof savedOfRecent,
];
