import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeFixtureStore } from "../harness/fixtureStore.js";

/**
 * Smoke test for the `PT_FEATURE_SHAPES=false` gate.
 *
 * When the flag is off, a feed that *does* include shapes.txt must still load
 * cleanly, but:
 *   - no shape records end up in the store.
 *
 * The fixture is the committed synthetic `tiny-gtfs-with-shapes` GTFS zip
 * (see crates/pt-producer/tests/fixtures/README.md for its source CSVs and
 * regeneration steps).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadFixtureZip(): Uint8Array {
  const path = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "crates",
    "pt-producer",
    "tests",
    "fixtures",
    "tiny-gtfs-with-shapes.zip",
  );
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("PT_FEATURE_SHAPES=false smoke", () => {
  const prevFlag = process.env.PT_FEATURE_SHAPES;

  beforeAll(() => {
    process.env.PT_FEATURE_SHAPES = "false";
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.PT_FEATURE_SHAPES;
    else process.env.PT_FEATURE_SHAPES = prevFlag;
  });

  it("strips shape state from the ingested store", async () => {
    const store = await makeFixtureStore(loadFixtureZip());

    // Store-level: no shapes recorded, no pre-serialized body, no hash.
    expect(store.getShapes()).toEqual([]);
    expect(store.getShapesBody()).toBe("");
    expect(store.getShapesHash()).toBe("");

  });
});

describe("PT_FEATURE_SHAPES=true baseline", () => {
  const prevFlag = process.env.PT_FEATURE_SHAPES;

  beforeAll(() => {
    // Explicit "true" — default is on, but we want the test to be independent
    // of process-level overrides.
    process.env.PT_FEATURE_SHAPES = "true";
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.PT_FEATURE_SHAPES;
    else process.env.PT_FEATURE_SHAPES = prevFlag;
  });

  it("retains shapes on the store when the flag is on", async () => {
    const store = await makeFixtureStore(loadFixtureZip());

    const shapes = store.getShapes();
    expect(shapes.length).toBe(2);
    expect(shapes.map((s) => s.shapeId).sort()).toEqual(["SH_A", "SH_B"]);
    expect(store.getShapesHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getShapesBody()).toContain("\"shapes\"");
  });
});
