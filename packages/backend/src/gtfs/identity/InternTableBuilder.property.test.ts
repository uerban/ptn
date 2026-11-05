import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createInternTableBuilder } from "./InternTableBuilder.js";

describe("InternTableBuilder — properties", () => {
  it("intern is a pure function of input", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string(), { maxLength: 100 }), (strings) => {
        const b = createInternTableBuilder<string>({ cap: 1000, label: "test" });
        const firstPass = strings.map((s) => b.intern(s));
        const secondPass = strings.map((s) => b.intern(s));
        expect(firstPass).toEqual(secondPass);
      }),
    );
  });

  it("round-trip: valueAt(intern(x)) === x", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const b = createInternTableBuilder<string>({ cap: 1000, label: "test" });
        const ix = b.intern(s);
        expect(b.valueAt(ix)).toBe(s);
      }),
    );
  });

  it("ix is always in [0, size)", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 100 }), (strings) => {
        const b = createInternTableBuilder<string>({ cap: 1000, label: "test" });
        for (const s of strings) {
          const ix = b.intern(s);
          expect(ix).toBeGreaterThanOrEqual(0);
          expect(ix).toBeLessThan(b.size);
        }
      }),
    );
  });

  it("size = number of distinct strings in input", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 100 }), (strings) => {
        const b = createInternTableBuilder<string>({ cap: 1000, label: "test" });
        for (const s of strings) b.intern(s);
        const expected = new Set(strings).size;
        expect(b.size).toBe(expected);
      }),
    );
  });

  it("ix values are a permutation of [0, size)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string(), { maxLength: 100 }), (strings) => {
        const b = createInternTableBuilder<string>({ cap: 1000, label: "test" });
        const ixs = strings.map((s) => b.intern(s));
        const sorted = [...ixs].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i++) {
          expect(sorted[i]).toBe(i);
        }
      }),
    );
  });

  it("cap enforcement: never exceeds cap, throws on overflow", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 100 }), (cap, attempts) => {
        const b = createInternTableBuilder<string>({ cap, label: "test" });
        let thrown = false;
        for (let i = 0; i < attempts; i++) {
          try {
            b.intern(`v${i}`);
          } catch {
            thrown = true;
          }
        }
        expect(b.size).toBeLessThanOrEqual(cap);
        if (attempts > cap) expect(thrown).toBe(true);
      }),
    );
  });
});
