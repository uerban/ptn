import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TtlLru } from "./ttlLru.js";

describe("TtlLru", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns set values within TTL", () => {
    const c = new TtlLru<string, number>({ maxSize: 2, ttlMs: 1000 });
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
  });

  it("returns undefined for expired entries", () => {
    const c = new TtlLru<string, number>({ maxSize: 2, ttlMs: 1000 });
    c.set("a", 1);
    vi.setSystemTime(new Date(1500));
    expect(c.get("a")).toBeUndefined();
  });

  it("evicts the oldest when capacity is exceeded", () => {
    const c = new TtlLru<string, number>({ maxSize: 2, ttlMs: 10000 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });

  it("set overwrites existing key and bumps it to most-recent", () => {
    const c = new TtlLru<string, number>({ maxSize: 2, ttlMs: 10000 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 99);
    c.set("c", 3);
    expect(c.get("a")).toBe(99);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });
});
