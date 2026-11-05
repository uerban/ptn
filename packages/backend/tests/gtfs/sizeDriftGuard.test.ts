import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeFixtureStore } from "../harness/fixtureStore.js";

const TINY_WITH_SHAPES = resolve(
  __dirname,
  "../../../../crates/pt-producer/tests/fixtures/tiny-gtfs-with-shapes.zip",
);

const MAX_GZIPPED_ESTIMATE_BYTES = 250 * 1024;

describe("shapes artifact size drift guard (tiny-gtfs-with-shapes fixture)", () => {
  it("stays under 250 kB gzipped estimate", async () => {
    const zipBytes = new Uint8Array(readFileSync(TINY_WITH_SHAPES));
    const store = await makeFixtureStore(zipBytes);
    const body = store.getShapesBody();
    const approxGzipped = Buffer.byteLength(body, "utf8") * 0.35;
    expect(approxGzipped).toBeLessThan(MAX_GZIPPED_ESTIMATE_BYTES);
  });
});
