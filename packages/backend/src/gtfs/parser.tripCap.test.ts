import { describe, it, expect, vi } from "vitest";
import { buildCappedTripStringTable } from "./parser.js";

describe("buildCappedTripStringTable", () => {
  it("interns up to the cap", () => {
    const t = buildCappedTripStringTable([], 3);
    expect(t.intern("a")).toBe(0);
    expect(t.intern("b")).toBe(1);
    expect(t.intern("c")).toBe(2);
    expect(t.size).toBe(3);
  });

  it("re-interning a known string is idempotent and does not count against cap", () => {
    const t = buildCappedTripStringTable([], 2);
    t.intern("a");
    t.intern("b");
    expect(() => t.intern("a")).not.toThrow();
    expect(t.size).toBe(2);
  });

  it("throws when cap exceeded", () => {
    const t = buildCappedTripStringTable([], 2);
    t.intern("a");
    t.intern("b");
    expect(() => t.intern("c")).toThrow(/trips|cap/i);
  });

  it("pre-seeded strings count against cap", () => {
    const t = buildCappedTripStringTable(["a", "b"], 2);
    expect(t.size).toBe(2);
    expect(() => t.intern("c")).toThrow(/trips|cap/i);
  });

  it("warns at 80% of cap", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = buildCappedTripStringTable([], 10);
      for (let i = 0; i < 8; i++) t.intern(`t${i}`);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/80%|trips/));
    } finally {
      spy.mockRestore();
    }
  });

  it("warning fires only once", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = buildCappedTripStringTable([], 10);
      for (let i = 0; i < 10; i++) t.intern(`t${i}`);
      const warnCalls = spy.mock.calls.filter((c) => /80%|trips/.test(String(c[0])));
      expect(warnCalls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
