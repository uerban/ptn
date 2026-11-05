import { describe, test, expect } from "vitest";
import { chipInsets } from "./bottomControlInsets.ts";

// A 375x600 map (iPhone 13 mini width) with MapLibre's default bottom-right
// stack: zoom group, geolocate, compact (i) attribution with 10px margins.
const MAP = { top: 0, bottom: 600, left: 0, right: 375 };
const ZOOM = { top: 459, bottom: 517, left: 336, right: 365 };
const LOCATE = { top: 527, bottom: 556, left: 336, right: 365 };
const ATTRIB_COLLAPSED = { top: 566, bottom: 590, left: 341, right: 365 };
const ATTRIB_EXPANDED = { top: 552, bottom: 590, left: 40, right: 365 };

describe("chipInsets", () => {
  test("collapsed (i): chips share its baseline and clear the control column", () => {
    expect(chipInsets(MAP, ATTRIB_COLLAPSED, [ZOOM, LOCATE], false)).toEqual({
      bottom: 10,
      right: 47, // 375 - 336 + 8
    });
  });

  test("expanded attribution: chips lift above it", () => {
    expect(chipInsets(MAP, ATTRIB_EXPANDED, [ZOOM, LOCATE], true)).toEqual({
      bottom: 56, // 600 - 552 + 8
      right: 47,
    });
  });

  test("wide inline attribution: chips stop before its text", () => {
    const wideMap = { top: 0, bottom: 800, left: 0, right: 1200 };
    const inline = { top: 780, bottom: 800, left: 900, right: 1200 };
    expect(chipInsets(wideMap, inline, [], false)).toEqual({ bottom: 8, right: 308 });
  });

  test("no attribution: bottom gap only", () => {
    expect(chipInsets(MAP, null, [], false)).toEqual({ bottom: 8, right: 0 });
  });
});
