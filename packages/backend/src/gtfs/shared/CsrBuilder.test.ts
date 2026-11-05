import { describe, it, expect } from "vitest";
import { createCsrBuilder } from "./CsrBuilder.js";

describe("CsrBuilder", () => {
  it("builds an empty CSR", () => {
    const b = createCsrBuilder<number>();
    const csr = b.finalize();
    expect(csr.groupCount).toBe(0);
    expect(csr.values.length).toBe(0);
    expect(Array.from(csr.offsets)).toEqual([0]);
  });

  it("builds a single empty group", () => {
    const b = createCsrBuilder<number>();
    b.endGroup();
    const csr = b.finalize();
    expect(csr.groupCount).toBe(1);
    expect(csr.values.length).toBe(0);
    expect(Array.from(csr.offsets)).toEqual([0, 0]);
  });

  it("builds a single group with values", () => {
    const b = createCsrBuilder<number>();
    b.push(10); b.push(20); b.push(30);
    b.endGroup();
    const csr = b.finalize();
    expect(csr.groupCount).toBe(1);
    expect(Array.from(csr.values as number[])).toEqual([10, 20, 30]);
    expect(Array.from(csr.offsets)).toEqual([0, 3]);
    expect(csr.groupAt(0)).toEqual([10, 20, 30]);
  });

  it("builds multiple groups", () => {
    const b = createCsrBuilder<number>();
    b.push(1); b.push(2); b.endGroup();
    b.endGroup();
    b.push(9); b.endGroup();
    const csr = b.finalize();
    expect(csr.groupCount).toBe(3);
    expect(Array.from(csr.offsets)).toEqual([0, 2, 2, 3]);
    expect(csr.groupAt(0)).toEqual([1, 2]);
    expect(csr.groupAt(1)).toEqual([]);
    expect(csr.groupAt(2)).toEqual([9]);
  });

  it("groupAt throws on out-of-range", () => {
    const b = createCsrBuilder<number>();
    b.push(1); b.endGroup();
    const csr = b.finalize();
    expect(() => csr.groupAt(-1)).toThrow();
    expect(() => csr.groupAt(1)).toThrow();
  });

  it("works with string values", () => {
    const b = createCsrBuilder<string>();
    b.push("r1"); b.push("r2"); b.endGroup();
    b.endGroup();
    b.push("r3"); b.endGroup();
    const csr = b.finalize();
    expect(csr.groupAt(0)).toEqual(["r1", "r2"]);
    expect(csr.groupAt(2)).toEqual(["r3"]);
  });
});
