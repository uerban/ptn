import { describe, it, expect } from "vitest";
import {
  SERVICE_NOTICES_SCHEMA_VERSION,
  isServiceNoticesBody,
  type ServiceNotice,
  type ServiceNoticesBody,
} from "./serviceNotices.js";
import golden from "./__fixtures__/service-notices.json";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("service notices contract", () => {
  it("starts at schema version 1", () => {
    expect(SERVICE_NOTICES_SCHEMA_VERSION).toBe(1);
  });

  it("accepts the golden body, which has exactly the contract's fields", () => {
    expect(isServiceNoticesBody(golden)).toBe(true);
    const body = golden as ServiceNoticesBody;
    expect(Object.keys(body).sort()).toEqual(["notices", "schemaVersion"]);
    const keys: (keyof ServiceNotice)[] = [
      "displayUntil", "free", "icon", "id", "kind", "routeIds", "source", "text", "windows",
    ];
    expect(Object.keys(body.notices[0]!).sort()).toEqual(keys);
    expect(body.notices.some((n) => n.city === true && n.routeIds === undefined)).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    expect(isServiceNoticesBody({ ...clone(golden), schemaVersion: 2 })).toBe(false);
  });

  it.each([
    ["no windows", (n: Record<string, unknown>) => { n.windows = []; }],
    ["end before start", (n: Record<string, unknown>) => {
      n.windows = [{ start: "2026-12-03T17:27:00Z", end: "2026-12-03T16:00:00Z" }];
    }],
    ["non-UTC instant", (n: Record<string, unknown>) => {
      n.windows = [{ start: "2026-12-03T18:00:00+02:00", end: "2026-12-03T19:27:00+02:00" }];
    }],
    ["both routes and city", (n: Record<string, unknown>) => { n.city = true; }],
    ["neither routes nor city", (n: Record<string, unknown>) => { delete n.routeIds; }],
    ["unknown kind", (n: Record<string, unknown>) => { n.kind = "holiday"; }],
    ["non-boolean free", (n: Record<string, unknown>) => { n.free = "yes"; }],
    ["bad displayUntil", (n: Record<string, unknown>) => { n.displayUntil = "31.12.2026"; }],
    ["non-https source", (n: Record<string, unknown>) => { n.source = "http://example.com"; }],
    ["empty text", (n: Record<string, unknown>) => { n.text = { lt: "" }; }],
    ["empty icon", (n: Record<string, unknown>) => { n.icon = ""; }],
    ["word icon", (n: Record<string, unknown>) => { n.icon = "🎄 bus"; }],
    ["long icon", (n: Record<string, unknown>) => { n.icon = "🎄🎄🎄🎄🎄"; }],
  ])("rejects a malformed notice: %s", (_name, mutate) => {
    const body = clone(golden) as { notices: Record<string, unknown>[] };
    mutate(body.notices[0]!);
    expect(isServiceNoticesBody(body)).toBe(false);
  });

  it("rejects non-objects and a missing list", () => {
    for (const value of [null, 1, "x", [], { schemaVersion: 1 }]) {
      expect(isServiceNoticesBody(value)).toBe(false);
    }
  });
});
