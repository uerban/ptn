import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { emitTsModule, readBuildInfo } from "./build-info.mjs";

const saved = {};
let dir;

beforeEach(() => {
  for (const key of ["PT_VERSION", "GIT_SHA"]) saved[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "build-info-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "0.2.3" }));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("an injected PT_VERSION and GIT_SHA are stamped as-is", () => {
  process.env.PT_VERSION = "0.2.44";
  process.env.GIT_SHA = "0459991f0459991f0459991f0459991f0459991f";
  const info = readBuildInfo(dir);
  assert.equal(info.version, "0.2.44");
  assert.equal(info.commit, "0459991f");
  assert.ok(!Number.isNaN(Date.parse(info.builtAt)));
});

test("without git or PT_VERSION the package.json patch is not displayed", () => {
  delete process.env.PT_VERSION;
  delete process.env.GIT_SHA;
  const info = readBuildInfo(dir);
  assert.equal(info.version, "0.2.0-dev");
  assert.equal(info.commit, "unknown");
});

test("emitted module carries the version", () => {
  const ts = emitTsModule({ version: "0.2.44-dev+0459991f", commit: "0459991f", builtAt: "2026-11-22T00:00:00.000Z" });
  assert.match(ts, /"version": "0\.2\.44-dev\+0459991f"/);
});
