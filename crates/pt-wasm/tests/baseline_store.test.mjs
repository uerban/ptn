import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainArtifact, readArtifact, retainRun } from "./baseline_store.mjs";

test("deduplicated bytes and immutable runs survive relocation", () => {
  const parent = mkdtempSync(join(tmpdir(), "baseline-store-"));
  try {
    const root = join(parent, "original");
    const digest = retainArtifact(root, Buffer.from("retained input"));
    assert.equal(retainArtifact(root, Buffer.from("retained input")), digest);
    const record = { schemaVersion: 1, artifacts: { ptb: digest }, candidates: [1, 2] };
    retainRun(root, "old", record);
    assert.throws(() => retainRun(root, "old", record), /EEXIST/);
    retainRun(root, "new", { ...record, candidates: [2, 1] });
    const moved = join(parent, "restored");
    cpSync(root, moved, { recursive: true });
    rmSync(root, { recursive: true });
    assert.equal(readArtifact(moved, digest).toString(), "retained input");
    assert.deepEqual(JSON.parse(readFileSync(join(moved, "runs", "old.json"))).candidates, [1, 2]);
    assert.throws(() => readArtifact(moved, "../escape"), /Invalid/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("missing and corrupt bytes reject reads and run finalization", () => {
  const root = mkdtempSync(join(tmpdir(), "baseline-corrupt-"));
  try {
    const digest = retainArtifact(root, Buffer.from("input"));
    writeFileSync(join(root, "artifacts", digest), "corrupt");
    assert.throws(() => readArtifact(root, digest), /integrity/);
    assert.throws(() => retainArtifact(root, Buffer.from("input")), /integrity/);
    assert.throws(() => retainRun(root, "bad", { schemaVersion: 1, artifacts: { ptb: digest } }), /integrity/);
    unlinkSync(join(root, "artifacts", digest));
    assert.throws(() => readArtifact(root, digest), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
