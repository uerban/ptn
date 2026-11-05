import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPtb } from "@pt/shared";

// Byte-parity gate for the producer-side label-anchors emit (Stage-C C2a).
//
// `color-artifacts-gen.mjs` (run via execFileSync below) is a SHIPPED prod
// artifact: it imports the backend from `../dist`. turbo's `test` task only
// builds DEPENDENCY packages (`dependsOn: ["^build"]`), NOT the backend's own
// dist, so a fresh checkout / CI has no `packages/backend/dist` —
// `vitest.globalSetup.ts` builds it ONCE before the fork pool spawns (mirrors
// schedule-tile-gen.test.ts). This test loads the reference `computeLabelAnchors`
// from that SAME dist via a runtime `file://` import — reference and script
// share the exact compiled solver, so the only thing under test is the script's
// plumbing (no src-vs-dist skew). The producer must feed `bundle.stops` to the
// solver in their natural PTB order (== canonical.iterStops order on the
// backend), so the producer-emitted anchors are byte-identical to the backend's.
type ComputeLabelAnchors =
  typeof import("../../src/gtfs/labelAnchors.js").computeLabelAnchors;
let computeLabelAnchors: ComputeLabelAnchors;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "color-artifacts-gen.mjs");
const FIXTURES = join(HERE, "..", "..", "src", "gtfs", "__fixtures__");

describe("color-artifacts-gen.mjs label-anchors.json byte parity", () => {
  let staging: string;
  let bundlePath: string;

  beforeAll(async () => {
    // Load the reference solver from the dist globalSetup guaranteed (the SAME
    // compiled code the producer script imports).
    const backendDir = join(HERE, "..", "..");
    const distFn = (m: string) =>
      pathToFileURL(join(backendDir, "dist", "gtfs", m)).href;
    ({ computeLabelAnchors } = await import(distFn("labelAnchors.js")));

    // Staging dir the script consumes: bundle.ptb + its sidecars (mirrors a
    // producer generation dir; the script reads bundle.ptb, the sidecars travel
    // with it for the other consumers).
    staging = mkdtempSync(join(tmpdir(), "ptn-laanchors-staging-"));
    bundlePath = join(staging, "bundle.ptb");
    copyFileSync(join(FIXTURES, "bundle.ptb"), bundlePath);
    copyFileSync(
      join(FIXTURES, "bundle.ptb.meta.json"),
      join(staging, "bundle.ptb.meta.json"),
    );
    copyFileSync(
      join(FIXTURES, "bundle.ptb.shapes.json"),
      join(staging, "bundle.ptb.shapes.json"),
    );
  });

  afterAll(() => {
    rmSync(staging, { recursive: true, force: true });
  });

  it("emits label-anchors.json identical to the backend computeLabelAnchors over PTB-order stops", () => {
    const stdout = execFileSync("node", [SCRIPT, staging], {
      cwd: join(HERE, "..", ".."),
      encoding: "utf8",
    });

    // The script prints one "<name> <sha256> <bytes>" line per artifact.
    expect(stdout).toMatch(/^label-anchors\.json [0-9a-f]{64} \d+$/m);

    const produced = JSON.parse(
      readFileSync(join(staging, "label-anchors.json"), "utf8"),
    );

    // Reference: feed bundle.stops to the EXACT backend solver in PTB order,
    // mapping PtbStop -> the {id,name,lat,lon} shape the solver reads (this is
    // the same field mapping loadFromPtb's synthStops does before
    // canonical.iterStops yields them to computeLabelAnchors).
    const bundle = loadPtb(readFileSync(bundlePath));
    const expected = Object.fromEntries(
      computeLabelAnchors(
        bundle.stops.map((s) => ({
          id: s.stopId,
          name: s.stopName,
          lat: s.stopLat,
          lon: s.stopLon,
          parentStation: "",
        })),
      ),
    );

    expect(produced).toEqual(expected);
    expect(Object.keys(produced).length).toBeGreaterThan(0);
  });
});
