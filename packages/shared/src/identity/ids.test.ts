import { describe, it, expect } from "vitest";
import {
  asStopIx,
  asRouteIx,
  asTripIx,
  asServiceIx,
  asHeadsignIx,
} from "./ids.js";

describe("identity ids — narrow constructors", () => {
  it("accepts valid uint32 values", () => {
    expect(asStopIx(0) as number).toBe(0);
    expect(asStopIx(0xFFFFFFFF) as number).toBe(0xFFFFFFFF);
    expect(asRouteIx(12345) as number).toBe(12345);
  });

  it("throws on negative", () => {
    expect(() => asStopIx(-1)).toThrow(/uint32|asStopIx/);
    expect(() => asTripIx(-0.5)).toThrow();
  });

  it("throws on non-integer", () => {
    expect(() => asStopIx(1.5)).toThrow(/uint32|asStopIx/);
  });

  it("throws when > uint32 max", () => {
    expect(() => asStopIx(0x1_0000_0000)).toThrow(/uint32|asStopIx/);
  });

  it("throws on NaN / Infinity", () => {
    expect(() => asRouteIx(NaN)).toThrow();
    expect(() => asServiceIx(Infinity)).toThrow();
  });

  it("each kind's constructor is independent", () => {
    expect(() => asHeadsignIx(7)).not.toThrow();
    expect(() => asTripIx(7)).not.toThrow();
  });
});
