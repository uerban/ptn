import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTE_SIDE_TABLE_REGION_ID, decodeRouteSideTable, loadPtb } from "./loader.js";
import { ptbBundleToWire } from "./ptbToBundleWire.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

const cases = fixture("route-side-table.tsv").toString("utf8").trim().split("\n")
  .map((line) => line.split("\t") as [string, string, string, string, string]);

/** Pool whose entry at index `i` is the text `s<i>`; index 0 stays empty. */
const poolOf = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => (i === 0 ? "" : `s${i}`));

function withRouteSide(source: Buffer, body: Buffer): Buffer {
  const TABLE_OFFSET = 32;
  const ENTRY_BYTES = 24;
  const offset = Math.ceil(source.length / 4096) * 4096;
  const out = Buffer.alloc(offset + body.length);
  source.copy(out);
  body.copy(out, offset);
  let entry = TABLE_OFFSET;
  while (out.readUInt16LE(entry) !== 0) entry += ENTRY_BYTES;
  out.writeUInt16LE(ROUTE_SIDE_TABLE_REGION_ID, entry);
  out.writeBigUInt64LE(BigInt(offset), entry + 8);
  out.writeBigUInt64LE(BigInt(body.length), entry + 16);
  return out;
}

function sideBody(numRoutes: number, networkIdx: number): Buffer {
  const body = Buffer.alloc(16 + 8 + numRoutes * 16);
  body.writeUInt16LE(1, 0);
  body.writeUInt32LE(numRoutes, 4);
  body.writeUInt32LE(1, 8);
  body.writeUInt32LE(networkIdx, 16);
  const sortBase = 24 + numRoutes * 8;
  const networkBase = sortBase + numRoutes * 4;
  for (let r = 0; r < numRoutes; r++) {
    body.writeUInt32LE(0xffffffff, sortBase + r * 4);
    body.writeUInt32LE(r === 0 ? 0 : 0xffffffff, networkBase + r * 4);
  }
  return body;
}

describe("decodeRouteSideTable", () => {
  it.each(cases)("%s", (_name, routes, strings, hex, expected) => {
    const table = decodeRouteSideTable(Buffer.from(hex, "hex"), Number(routes), poolOf(Number(strings)));
    if (expected === "absent" || expected === "malformed") {
      expect(table).toBeUndefined();
    } else {
      expect(table).toBeDefined();
    }
  });

  it("resolves strings, absent values and network ordinals", () => {
    const valid = cases.find(([name]) => name === "valid")!;
    expect(decodeRouteSideTable(Buffer.from(valid[3], "hex"), 3, poolOf(6))).toEqual({
      networks: [{ id: "s1", name: "s2" }, { id: "s3" }],
      routes: [
        { desc: "s4", url: "s5", sortOrder: 7, networkId: "s1" },
        {},
        { networkId: "s3" },
      ],
    });
  });
});

describe("route side table in a bundle", () => {
  it("leaves older bundles without networks", () => {
    const ptb = loadPtb(fixture("tiny.ptb"));
    expect(ptb.routeSide).toBeUndefined();
    const wire = ptbBundleToWire(ptb);
    expect(wire.networks).toBeUndefined();
    expect(wire.routes.every((route) => route.networkId === undefined)).toBe(true);
  });

  it("carries networks onto the wire", () => {
    const base = loadPtb(fixture("tiny.ptb"));
    const networkIdx = base.stringPool.findIndex((text) => text.length > 0);
    const ptb = loadPtb(withRouteSide(fixture("tiny.ptb"), sideBody(base.routes.length, networkIdx)));
    const wire = ptbBundleToWire(ptb);
    const networkId = base.stringPool[networkIdx]!;
    expect(wire.networks).toEqual([{ id: networkId }]);
    const firstRouteId = base.routes[0]!.routeId;
    const tagged = wire.routes.filter((route) => route.networkId === networkId);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((route) => route.id === firstRouteId)).toBe(true);
  });

  it("ignores a malformed region and still loads the bundle", () => {
    const base = loadPtb(fixture("tiny.ptb"));
    const ptb = loadPtb(withRouteSide(fixture("tiny.ptb"), sideBody(base.routes.length + 1, 1)));
    expect(ptb.routeSide).toBeUndefined();
    expect(ptb.routes.length).toBe(base.routes.length);
  });
});
