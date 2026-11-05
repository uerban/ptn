import { describe, it, expect, vi } from "vitest";
import { createInternTableBuilder } from "./InternTableBuilder.js";

describe("createInternTableBuilder — basic semantics", () => {
  it("assigns monotonic ix starting at 0", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    expect(b.intern("a")).toBe(0);
    expect(b.intern("b")).toBe(1);
    expect(b.intern("c")).toBe(2);
  });

  it("intern is idempotent: same value returns same ix", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    const ix1 = b.intern("x");
    const ix2 = b.intern("x");
    expect(ix1).toBe(ix2);
  });

  it("indexOf returns -1 for unknown, ix for known", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    expect(b.indexOf("unknown")).toBe(-1);
    b.intern("x");
    expect(b.indexOf("x")).toBe(0);
  });

  it("valueAt returns interned value, throws on out-of-range", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    b.intern("x");
    b.intern("y");
    expect(b.valueAt(0)).toBe("x");
    expect(b.valueAt(1)).toBe("y");
    expect(() => b.valueAt(2)).toThrow(/out of range|range/i);
    expect(() => b.valueAt(-1)).toThrow();
  });

  it("size reflects count of distinct entries", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    b.intern("a");
    b.intern("b");
    b.intern("a");
    expect(b.size).toBe(2);
  });

  it("freeze returns an InternTable with same values", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    b.intern("a");
    b.intern("b");
    const t = b.freeze();
    expect(t.size).toBe(2);
    expect(t.valueAt(0)).toBe("a");
    expect(t.indexOf("b")).toBe(1);
  });

  it("calling intern after freeze throws", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    b.intern("x");
    b.freeze();
    expect(() => b.intern("y")).toThrow(/frozen|closed|freeze/i);
  });
});

describe("createInternTableBuilder — cap enforcement", () => {
  it("throws on overflow", () => {
    const b = createInternTableBuilder<string>({ cap: 2, label: "stops" });
    b.intern("a");
    b.intern("b");
    expect(() => b.intern("c")).toThrow(/cap|stops/i);
  });

  it("re-interning does not consume cap", () => {
    const b = createInternTableBuilder<string>({ cap: 2, label: "stops" });
    b.intern("a");
    b.intern("b");
    expect(() => b.intern("a")).not.toThrow();
    expect(b.size).toBe(2);
  });

  it("warns once at 80% of cap", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
      for (let i = 0; i < 8; i++) b.intern(`v${i}`);
      const warnCalls = spy.mock.calls.filter((c) => /80%|stops/.test(String(c[0])));
      expect(warnCalls).toHaveLength(1);
      for (let i = 8; i < 10; i++) b.intern(`v${i}`);
      const warnCallsAgain = spy.mock.calls.filter((c) => /80%|stops/.test(String(c[0])));
      expect(warnCallsAgain).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createInternTableBuilder — edge values", () => {
  it("handles empty-string", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    expect(b.intern("")).toBe(0);
    expect(b.indexOf("")).toBe(0);
    expect(b.valueAt(0)).toBe("");
  });

  it("treats whitespace-only strings as distinct", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    expect(b.intern("a")).toBe(0);
    expect(b.intern(" a")).toBe(1);
    expect(b.intern("a ")).toBe(2);
    expect(b.intern(" a ")).toBe(3);
  });

  it("treats unicode NFC vs NFD as distinct (documented behavior)", () => {
    const b = createInternTableBuilder<string>({ cap: 10, label: "stops" });
    const nfc = "é";
    const nfd = "\u0065\u0301";
    const ix1 = b.intern(nfc);
    const ix2 = b.intern(nfd);
    expect(ix1).not.toBe(ix2);
    expect(b.valueAt(ix1)).toBe(nfc);
    expect(b.valueAt(ix2)).toBe(nfd);
  });
});
