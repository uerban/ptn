import { describe, it, expect, beforeEach } from "vitest";
import {
  decodeShape,
  clearShapeDecodeCache,
  __shapeDecodeCacheSize,
} from "../../../src/services/legGeometry/shapeDecodeCache";

const polyline = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

describe("shapeDecodeCache", () => {
  beforeEach(() => clearShapeDecodeCache());

  it("identical reference on repeat calls for same shapeId", () => {
    const a = decodeShape("X", polyline);
    const b = decodeShape("X", polyline);
    expect(a).toBe(b);
  });

  it("different shapeIds decode independently", () => {
    const a = decodeShape("X", polyline);
    const b = decodeShape("Y", polyline);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("LRU cap at 1024", () => {
    for (let i = 0; i < 1025; i++) decodeShape(`S${i}`, polyline);
    expect(__shapeDecodeCacheSize()).toBeLessThanOrEqual(1024);
  });

  it("clear() drops entries", () => {
    decodeShape("A", polyline);
    clearShapeDecodeCache();
    expect(__shapeDecodeCacheSize()).toBe(0);
  });
});
