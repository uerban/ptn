import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {GLUE_EXECUTION, glueExecutionMode, importBaselineGlue} from "./baseline_glue.mjs";

test("snapshot executes observed bytes after the original source changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-glue-"));
  try {
    const path = join(dir, "source with spaces.mjs");
    writeFileSync(path, 'export const value="observed snapshot";');
    const observed = readFileSync(path);
    writeFileSync(path, 'export const value="replacement file";');
    assert.equal((await importBaselineGlue(observed, path)).value, "observed snapshot");
    assert.equal((await importBaselineGlue(observed, path, "file")).value, "replacement file");
  } finally {rmSync(dir, {recursive:true,force:true});}
});

test("relative dependencies are not silently loaded from the original directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-glue-dependency-"));
  try {
    const path = join(dir,"root.mjs");
    writeFileSync(join(dir,"dependency.mjs"), 'export const value="external bytes";');
    writeFileSync(path, 'export {value} from "./dependency.mjs";');
    const bytes = readFileSync(path);
    assert.equal((await importBaselineGlue(bytes,path,"file")).value,"external bytes");
    await assert.rejects(importBaselineGlue(bytes,path), /relative|Invalid URL|cannot be resolved/i);
  } finally {rmSync(dir, {recursive:true,force:true});}
});

test("runtime builtins remain available in snapshot mode", async () => {
  const pkg = await importBaselineGlue(Buffer.from('import {sep} from "node:path"; export {sep};'), "/unused.mjs");
  assert.equal(typeof pkg.sep, "string");
});

test("legacy metadata maps explicitly and unknown contracts are refused", async () => {
  assert.equal(glueExecutionMode(undefined),"file");
  assert.equal(glueExecutionMode(GLUE_EXECUTION.snapshot),"snapshot");
  for(const value of [null,"", "unknown"]) assert.throws(()=>glueExecutionMode(value),/Unsupported/);
  await assert.rejects(importBaselineGlue(Buffer.from(""),"/unused.mjs","unknown"),/Unsupported/);
});
