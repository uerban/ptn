import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { encodeLatE7, encodeLonE7, decodeE7 } from "./coordQuant.js";
const url = new URL(
  "../../../../crates/pt-core/tests/fixtures/coord-oracle.json",
  import.meta.url,
);
if (!existsSync(url)) throw new Error(`oracle not found at ${url.pathname}`);
const rows = JSON.parse(readFileSync(url, "utf8"));
const parse = (s: string) => (s === "nan" ? NaN : s === "inf" ? Infinity : Number(s));
const prodHex = (x: number) => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x * 1e7, true);
  return b.getBigUint64(0, true).toString(16).padStart(16, "0");
};
describe("coordQuant", () => {
  it("matches the oracle (>=20 rows, lat/lon axis, prod bits, decode tol)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const r of rows) {
      const x = parse(r.in);
      const enc = r.axis === "lat" ? encodeLatE7(x) : encodeLonE7(x);
      if (r.reject) {
        expect(enc).toBeNull();
        continue;
      }
      if (r.prod_hex) expect(prodHex(x)).toBe(r.prod_hex);
      expect(enc).toBe(r.i32);
      expect(Math.abs(decodeE7(r.i32) - x)).toBeLessThanOrEqual(0.5e-7);
    }
  });
  it("half-away disagrees with bare Math.round on the .5 row", () => {
    expect(encodeLatE7(-5e-8)).toBe(-1);
    expect(Math.round(-5e-8 * 1e7)).toBe(-0);
  });
});
