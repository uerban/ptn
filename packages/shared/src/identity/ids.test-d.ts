import { describe, it, expectTypeOf } from "vitest";
import {
  asStopIx,
  asRouteIx,
  asTripIx,
  asServiceIx,
  asHeadsignIx,
  type StopIx,
  type RouteIx,
  type TripIx,
  type ServiceIx,
  type HeadsignIx,
} from "./ids.js";

describe("identity ids — type-level safety", () => {
  it("asStopIx returns StopIx", () => {
    expectTypeOf(asStopIx(1)).toEqualTypeOf<StopIx>();
  });

  it("StopIx is not assignable to RouteIx", () => {
    const s: StopIx = asStopIx(1);
    // @ts-expect-error — StopIx and RouteIx are distinct branded types
    const _r: RouteIx = s;
    void _r;
  });

  it("RouteIx is not assignable to StopIx", () => {
    const r: RouteIx = asRouteIx(2);
    // @ts-expect-error — distinct brands
    const _s: StopIx = r;
    void _s;
  });

  it("TripIx / ServiceIx / HeadsignIx are mutually exclusive", () => {
    const t: TripIx = asTripIx(3);
    const sv: ServiceIx = asServiceIx(4);
    const h: HeadsignIx = asHeadsignIx(5);
    // @ts-expect-error
    const _t1: ServiceIx = t;
    // @ts-expect-error
    const _t2: HeadsignIx = sv;
    // @ts-expect-error
    const _t3: TripIx = h;
    void _t1; void _t2; void _t3;
  });

  it("a plain number is not assignable to any IdentityIx", () => {
    const n = 42;
    // @ts-expect-error — number needs explicit constructor
    const _s: StopIx = n;
    void _s;
  });
});
