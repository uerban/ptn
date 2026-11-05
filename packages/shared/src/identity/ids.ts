/**
 * Identity indexes — branded uint32 references into per-kind intern tables.
 *
 * Every identity ix is at runtime a plain `number`, but at type level each
 * kind (StopIx, RouteIx, TripIx, ServiceIx, HeadsignIx) is a distinct branded
 * type. This prevents a RouteIx from being silently passed where a StopIx is
 * expected — caught at compile time by the TypeScript type checker.*/

declare const StopIxBrand: unique symbol;
declare const RouteIxBrand: unique symbol;
declare const TripIxBrand: unique symbol;
declare const ServiceIxBrand: unique symbol;
declare const HeadsignIxBrand: unique symbol;

export type StopIx = number & { readonly [StopIxBrand]: true };
export type RouteIx = number & { readonly [RouteIxBrand]: true };
export type TripIx = number & { readonly [TripIxBrand]: true };
export type ServiceIx = number & { readonly [ServiceIxBrand]: true };
export type HeadsignIx = number & { readonly [HeadsignIxBrand]: true };

export type IdentityIx = StopIx | RouteIx | TripIx | ServiceIx | HeadsignIx;

function assertU32(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFF_FFFF) {
    throw new RangeError(`${name}: expected uint32, got ${n}`);
  }
}

export function asStopIx(n: number): StopIx {
  assertU32(n, "asStopIx");
  return n as StopIx;
}

export function asRouteIx(n: number): RouteIx {
  assertU32(n, "asRouteIx");
  return n as RouteIx;
}

export function asTripIx(n: number): TripIx {
  assertU32(n, "asTripIx");
  return n as TripIx;
}

export function asServiceIx(n: number): ServiceIx {
  assertU32(n, "asServiceIx");
  return n as ServiceIx;
}

export function asHeadsignIx(n: number): HeadsignIx {
  assertU32(n, "asHeadsignIx");
  return n as HeadsignIx;
}
