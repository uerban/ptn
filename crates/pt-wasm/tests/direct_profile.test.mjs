import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = process.env.PT_WASM_DIRECT_PKG;

test("feature-gated WASM direct profile preserves both scheduled departures", async () => {
  assert.ok(pkgPath, "PT_WASM_DIRECT_PKG must name a generated experimental web package");
  const resolved = resolve(pkgPath);
  const pkg = await import(pathToFileURL(resolved).href);
  pkg.initSync({ module: readFileSync(join(dirname(resolved), "pt_wasm_bg.wasm")) });
  const router = new pkg.PtRouter(
    readFileSync(join(here, "../../../packages/shared/src/ptb/__fixtures__/tiny.ptb")),
    "covering-merge",
  );
  try {
    const query = {
      date: "20260505",
      departureSecs: 25000,
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
    };
    const points = router.planTemporalDirect(query, { startSecs: 25000, endSecs: 30000 });
    assert.deepEqual(points.map(({ departureSecs, arrivalSecs }) => [departureSecs, arrivalSecs]), [
      [28800, 29400],
      [25200, 25800],
    ]);
  } finally {
    router.free();
  }
});

test("direct profile excludes departures before query departure", async () => {
  assert.ok(pkgPath, "PT_WASM_DIRECT_PKG must name a generated experimental web package");
  const resolved = resolve(pkgPath);
  const pkg = await import(pathToFileURL(resolved).href);
  pkg.initSync({ module: readFileSync(join(dirname(resolved), "pt_wasm_bg.wasm")) });
  const router = new pkg.PtRouter(
    readFileSync(join(here, "../../../packages/shared/src/ptb/__fixtures__/tiny.ptb")),
    "covering-merge",
  );
  try {
    const query = {
      date: "20260505",
      departureSecs: 28000,
      entryStops: [{ stopId: "S1", walkSecs: 0 }],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
    };
    const points = router.planTemporalDirect(query, { startSecs: 25000, endSecs: 30000 });
    assert.deepEqual(points.map(({ departureSecs }) => departureSecs), [28800]);
  } finally {
    router.free();
  }
});

test("M4 retains earlier lower-walking alternatives that R3 dominates", async () => {
  assert.ok(pkgPath, "PT_WASM_DIRECT_PKG must name a generated experimental web package");
  const resolved = resolve(pkgPath);
  const pkg = await import(pathToFileURL(resolved).href);
  pkg.initSync({ module: readFileSync(join(dirname(resolved), "pt_wasm_bg.wasm")) });
  const router = new pkg.PtRouter(
    readFileSync(join(here, "../../../packages/shared/src/ptb/__fixtures__/tiny.ptb")),
    "covering-merge",
  );
  try {
    const query = {
      date: "20260505",
      departureSecs: 25000,
      entryStops: [
        { stopId: "S1", walkSecs: 0 },
        { stopId: "S2", walkSecs: 60 },
      ],
      exitStops: [{ stopId: "S3", walkSecs: 0 }],
    };
    const points = router.planTemporalDirect(query, { startSecs: 25000, endSecs: 30000 });
    const objective = process.env.PT_WASM_DIRECT_OBJECTIVE ?? "r3";
    assert.equal(points.length, objective === "m4" ? 4 : 2);
    assert.equal(points.some((point) => point.departureSecs === 25200 && point.totalWalkSecs === 0), objective === "m4");
  } finally {
    router.free();
  }
});

test("v2 direct profile expands exact frequencies and retains overnight service identity", async () => {
  assert.ok(pkgPath, "PT_WASM_DIRECT_PKG must name a generated experimental web package");
  const resolved = resolve(pkgPath);
  const pkg = await import(pathToFileURL(resolved).href);
  pkg.initSync({ module: readFileSync(join(dirname(resolved), "pt_wasm_bg.wasm")) });
  const router = new pkg.PtRouter(
    readFileSync(join(here, "../../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb")),
    "covering-merge",
  );
  try {
    const query = {
      date: "20260507", departureSecs: 43200,
      entryStops: [{ stopId: "S3", walkSecs: 0 }],
      exitStops: [{ stopId: "S4", walkSecs: 0 }],
    };
    const points = router.planTemporalDirect(query, { startSecs: 43200, endSecs: 46800 });
    assert.deepEqual(points.map(({ departureSecs, arrivalSecs }) => [departureSecs, arrivalSecs]),
      [[45600, 46200], [44400, 45000], [43200, 43800]]);
    query.departureSecs = 3600;
    const overnight = router.planTemporalDirect(query, { startSecs: 3600, endSecs: 3601 });
    assert.equal(overnight.length, 1);
    assert.equal(overnight[0].departureSecs, 3600);
    assert.equal(overnight[0].arrivalSecs, 4800);
    assert.equal(overnight[0].serviceDate, 20260506);
  } finally {
    router.free();
  }
});
