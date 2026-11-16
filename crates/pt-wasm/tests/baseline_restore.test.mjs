import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {retainArtifact, retainRun} from "./baseline_store.mjs";
import {restoreBaseline} from "./baseline_restore.mjs";

for (const damage of ["missing", "corrupt"]) {
  test(`restore rejects a ${damage} retained source dependency before writing output`, () => {
    const root = mkdtempSync(join(tmpdir(), "pt-baseline-extra-"));
    try {
      const artifacts = Object.fromEntries(["ptb", "queryTuples", "glue", "wasm", "sourceGTFS"]
        .map(name => [name, retainArtifact(root, Buffer.from(name))]));
      retainRun(root, "baseline", {schemaVersion: 1, completion: "success", artifacts});
      const path = join(root,"artifacts",artifacts.sourceGTFS);
      if (damage === "missing") unlinkSync(path);
      else writeFileSync(path, "corrupt");
      const destination = join(root,"restored");
      assert.throws(() => restoreBaseline(root,"baseline",destination), /ENOENT|integrity/);
      assert.equal(existsSync(destination), false);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
}
