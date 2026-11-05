import { describe, test, expect } from "vitest";
import { controlLift } from "./sheetControlLift.ts";

// iPhone 13 mini: map from y=44 to y=755; control column ~150px tall.
const MAP = { top: 44, bottom: 755 };
const CONTROLS = 150;

describe("controlLift", () => {
  test("no sheet: controls stay at the bottom", () => {
    expect(controlLift(MAP, [], CONTROLS)).toEqual({ lift: 0, hidden: false });
  });

  test("peek sheet: controls sit right on its edge", () => {
    expect(controlLift(MAP, [{ top: 635, bottom: 755 }], CONTROLS)).toEqual({
      lift: 120,
      hidden: false,
    });
  });

  test("half sheet: follows its real height, not a fixed offset", () => {
    expect(controlLift(MAP, [{ top: 349, bottom: 755 }], CONTROLS)).toEqual({
      lift: 406,
      hidden: false,
    });
  });

  test("full sheet: no room above it, controls hide", () => {
    expect(controlLift(MAP, [{ top: 25, bottom: 755 }], CONTROLS).hidden).toBe(true);
  });

  test("two sheets: the taller one wins", () => {
    expect(
      controlLift(MAP, [{ top: 635, bottom: 755 }, { top: 500, bottom: 755 }], CONTROLS).lift,
    ).toBe(255);
  });
});
