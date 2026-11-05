import { describe, it, expect } from "vitest";
import {
  scheduleTileCoordAt,
  scheduleCellBounds,
  parseTileCoords,
  quadrantDigitForPoint,
} from "@pt/shared";
import { isOwningTile } from "./isOwningTile.js";

describe("isOwningTile (4-arg)", () => {
  const stop = { lat: 54.6892, lon: 25.2798 };
  const { x, y } = scheduleTileCoordAt(stop.lat, stop.lon);
  const cellKey = `${x}_${y}`;
  const cellBounds = scheduleCellBounds(x, y);

  it("unsubdivided: owns its own cell (suffix '', leafSet null)", () => {
    expect(isOwningTile(stop, parseTileCoords(cellKey)!, null, cellBounds)).toBe(true);
  });
  it("unsubdivided: does not own a different cell", () => {
    const other = parseTileCoords("0_0")!;
    expect(isOwningTile(stop, other, null, scheduleCellBounds(0, 0))).toBe(false);
  });
  it("subdivided: owns the leaf leafForPoint selects, not a sibling", () => {
    // depth-1 quadrant digit for the stop within its own cell:
    const ownDigit = quadrantDigitForPoint(cellBounds, stop.lat, stop.lon);
    const sibling = ((ownDigit + 1) % 4).toString();
    const leafSet = new Set([ownDigit.toString(), sibling]);
    // isOwningTile resolves owningSuffix internally via leafForPoint(cellBounds,...,leafSet)
    expect(isOwningTile(stop, parseTileCoords(`${cellKey}-${ownDigit}`)!, leafSet, cellBounds)).toBe(true);
    expect(isOwningTile(stop, parseTileCoords(`${cellKey}-${sibling}`)!, leafSet, cellBounds)).toBe(false);
  });
  it("subdivided: a leaf coord on the WRONG cell is not owned", () => {
    const leafSet = new Set(["0"]);
    expect(
      isOwningTile(stop, parseTileCoords("0_0-0")!, leafSet, scheduleCellBounds(0, 0)),
    ).toBe(false);
  });
});
