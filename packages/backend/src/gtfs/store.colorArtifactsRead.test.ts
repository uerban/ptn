import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ColorConfig } from "@pt/shared";
import { GtfsStore } from "./store.js";
import { buildIndexes } from "./index-builder.js";
import {
  fixtureStops,
  fixtureRoutes,
  fixtureTrips,
  fixtureStopTimes,
  fixtureServices,
} from "./__fixtures__/simpleCity.js";

// store.ts reads the producer's published color-config.json / route-styles.json /
// label-anchors.json off disk instead of recomputing them (see the color artifacts rust native
// notes). These tests mirror crates/pt-serve/src/app/stops.rs's parse_route_styles /
// parse_label_anchors test coverage (happy path + missing/malformed → empty, never throw) for
// structural parity between the two languages' handling of the same on-disk contract.

// Route R1 (from the simpleCity fixture) is styled as "BUS:express", colored
// via the sub-mode entry in color-config.json (route-styles.json's own
// color/textColor fields are NOT consulted by the backend — only `subMode` is;
// the actual color comes from color-config.json's `modes[].color`, matching
// computeColorConfig's implementation).
const COLOR_CONFIG: ColorConfig = {
  modes: [
    {
      id: "BUS:express",
      label: "Bus (blue)",
      labelMode: "BUS",
      labelColor: "blue",
      parentMode: "BUS",
      color: "#3355ff",
      routeCount: 1,
      sampleRoutes: ["1"],
    },
  ],
  palettes: {
    light: {
      universal: { "BUS:express": "#3355ff" },
      deuteranopia: { "BUS:express": "#3355ff" },
      protanopia: { "BUS:express": "#3355ff" },
      tritanopia: { "BUS:express": "#3355ff" },
      highContrast: { "BUS:express": "#3355ff" },
    },
    dark: {
      universal: { "BUS:express": "#3355ff" },
      deuteranopia: { "BUS:express": "#3355ff" },
      protanopia: { "BUS:express": "#3355ff" },
      tritanopia: { "BUS:express": "#3355ff" },
      highContrast: { "BUS:express": "#3355ff" },
    },
  },
  universalLimited: false,
};

const ROUTE_STYLES = { R1: { color: "#3355ff", textColor: "#ffffff", subMode: "BUS:express" } };

// S_A/S_B get anchors; S_C (in the fixture but not here) exercises the
// per-stop fallback to `undefined`.
const LABEL_ANCHORS = { S_A: "top-left", S_B: "bottom-right" };

function buildFixtureStoreArgs() {
  return buildIndexes(fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, []);
}

function labelAnchorFor(store: GtfsStore, stopId: string): string | undefined {
  return store.getAllStops().find((s) => s.id === stopId)?.labelAnchor;
}

describe("GtfsStore color artifact file-read", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptn-color-artifacts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generationDir undefined: colorConfig null, resolvers undefined, labelAnchors empty", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    store.swap(indexes, canonical, routingInput, 0, undefined);

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
    for (const stop of fixtureStops) {
      expect(labelAnchorFor(store, stop.id)).toBeUndefined();
    }
  });

  it("generationDir set, both files valid: colorConfig/routeSubModeMap/labelAnchors correctly parsed", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    store.swap(indexes, canonical, routingInput, 0, dir);

    expect(store.getColorConfig()).toEqual(COLOR_CONFIG);
    expect(store.resolveRouteSubMode("R1")).toBe("BUS:express");
    expect(store.resolveRouteColor("R1")).toBe("#3355ff");
    // Unclassified/unknown routes still fall back to undefined.
    expect(store.resolveRouteSubMode("unknown")).toBeUndefined();
    expect(store.resolveRouteColor("unknown")).toBeUndefined();

    expect(labelAnchorFor(store, "S_A")).toBe("top-left");
    expect(labelAnchorFor(store, "S_B")).toBe("bottom-right");
    // S_C has no entry in label-anchors.json.
    expect(labelAnchorFor(store, "S_C")).toBeUndefined();
  });

  it("generationDir set, color-config.json missing: colorConfig null, resolvers undefined (not throw)", () => {
    // route-styles.json present and valid; color-config.json absent entirely.
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
    // Label anchors are read independently of color config, so they're
    // unaffected by the missing color-config.json.
    expect(labelAnchorFor(store, "S_A")).toBe("top-left");
  });

  it("generationDir set, color-config.json valid JSON but wrong shape (missing `modes`): colorConfig null, resolvers undefined (not throw)", () => {
    // `{}` is syntactically valid JSON, so readArtifactJson's try/catch
    // around readFileSync/JSON.parse can't catch this — computeColorConfig
    // must guard the shape itself before touching `.modes`.
    writeFileSync(join(dir, "color-config.json"), "{}");
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, route-styles.json valid JSON but wrong shape (a bare number): colorConfig null, resolvers undefined (not throw)", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), "42");
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, color-config.json modes array contains a null element: colorConfig null, resolvers undefined (not throw)", () => {
    // `modes` is a well-formed array, but one element is `null` — the
    // top-level Array.isArray(modes) check passes, so this only surfaces
    // once `sm.id` is accessed on the null element unless every element is
    // individually shape-checked.
    writeFileSync(join(dir, "color-config.json"), JSON.stringify({ modes: [null], universalLimited: false }));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, color-config.json modes array contains an empty object: colorConfig null, resolvers undefined", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify({
      modes: [{}],
      palettes: COLOR_CONFIG.palettes,
      universalLimited: false,
    }));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, route-styles.json has a null value for a route: colorConfig null, resolvers undefined (not throw)", () => {
    // routeStyles is a well-formed plain object, but one value is `null` —
    // the top-level shape check passes, so this only surfaces once
    // `style.subMode` is accessed on the null value unless every value is
    // individually shape-checked.
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify({ R1: null }));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, route-styles.json has a non-string subMode: colorConfig null, resolvers undefined", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify({
      R1: { color: "#3355ff", textColor: "#ffffff", subMode: 42 },
    }));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, color-config.json missing `palettes`: colorConfig null, resolvers undefined (not throw)", () => {
    // `palettes` is never read inside computeColorConfig itself, but it's
    // stored verbatim into `this.colorConfig` and served as-is via
    // getColorConfig() — the frontend does `colorConfig.palettes[theme]`
    // unguarded, so a missing/wrong-shape `palettes` doesn't throw here, it
    // throws in the browser. `modes: []` alone would otherwise vacuously
    // pass a modes-only guard.
    writeFileSync(join(dir, "color-config.json"), JSON.stringify({ modes: [], universalLimited: false }));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, color-config.json `palettes` is an array (wrong shape): colorConfig null, resolvers undefined (not throw)", () => {
    writeFileSync(
      join(dir, "color-config.json"),
      JSON.stringify({ modes: COLOR_CONFIG.modes, palettes: [], universalLimited: false }),
    );
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
  });

  it("generationDir set, color-config.json has malformed nested palettes: colorConfig null, resolvers undefined", () => {
    writeFileSync(
      join(dir, "color-config.json"),
      JSON.stringify({
        modes: COLOR_CONFIG.modes,
        palettes: {
          light: {
            ...COLOR_CONFIG.palettes.light,
            universal: { "BUS:express": 123 },
          },
          dark: COLOR_CONFIG.palettes.dark,
        },
        universalLimited: false,
      }),
    );
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, route-styles.json malformed JSON: colorConfig null, resolvers undefined (not throw)", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), "{not valid json");
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(LABEL_ANCHORS));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    expect(store.getColorConfig()).toBeNull();
    expect(store.resolveRouteColor("R1")).toBeUndefined();
    expect(store.resolveRouteSubMode("R1")).toBeUndefined();
  });

  it("generationDir set, label-anchors.json missing: labelAnchors empty (not throw), colorConfig unaffected", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    // label-anchors.json intentionally not written.

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    for (const stop of fixtureStops) {
      expect(labelAnchorFor(store, stop.id)).toBeUndefined();
    }
    // Color config is read independently of label anchors, so it's
    // unaffected by the missing label-anchors.json.
    expect(store.getColorConfig()).toEqual(COLOR_CONFIG);
  });

  it("generationDir set, label-anchors.json malformed JSON: labelAnchors empty (not throw)", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), "not json at all");

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    for (const stop of fixtureStops) {
      expect(labelAnchorFor(store, stop.id)).toBeUndefined();
    }
  });

  it("generationDir set, label-anchors.json valid JSON but wrong shape (an array): labelAnchors empty (not throw)", () => {
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    // A JSON array is valid JSON but the wrong top-level shape (expected a
    // plain stopId → anchor object map).
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify(["top-left"]));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    for (const stop of fixtureStops) {
      expect(labelAnchorFor(store, stop.id)).toBeUndefined();
    }
  });

  it("generationDir set, label-anchors.json has a value outside the LabelAnchor union: labelAnchors empty (not throw)", () => {
    // The container is a well-formed plain object (passes the top-level
    // shape check), but a value is not one of the 8 valid LabelAnchor
    // strings — this wouldn't throw anywhere (it's just embedded into
    // StopWithRoutes.labelAnchor verbatim), but per-value validation still
    // matters: a malformed artifact should degrade the whole file to empty
    // rather than serve a mix of valid and garbage anchors.
    writeFileSync(join(dir, "color-config.json"), JSON.stringify(COLOR_CONFIG));
    writeFileSync(join(dir, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(dir, "label-anchors.json"), JSON.stringify({ S_A: "north-by-northwest" }));

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildFixtureStoreArgs();
    expect(() => store.swap(indexes, canonical, routingInput, 0, dir)).not.toThrow();

    for (const stop of fixtureStops) {
      expect(labelAnchorFor(store, stop.id)).toBeUndefined();
    }
  });
});
