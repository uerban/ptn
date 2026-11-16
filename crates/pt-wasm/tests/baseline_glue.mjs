import {pathToFileURL} from "node:url";

export const GLUE_EXECUTION = {
  snapshot: "snapshot-data-url-v1",
  file: "file-url-v0",
};

/** Missing metadata identifies the original schema-v1 file-import contract. */
export function glueExecutionMode(contract) {
  if (contract === undefined || contract === GLUE_EXECUTION.file) return "file";
  if (contract === GLUE_EXECUTION.snapshot) return "snapshot";
  throw new Error(`Unsupported glue execution contract: ${contract}`);
}

/** Execute the bytes observed by the runner, not a second read of its path.
 * Snapshot mode supports self-contained web glue and runtime builtins. Relative
 * imports and file-relative import.meta.url semantics are intentionally absent;
 * arbitrary external module/file dependencies are not captured by this helper.
 * File mode exists for explicit replay of legacy captures, not byte identity. */
export async function importBaselineGlue(bytes, sourcePath, mode = "snapshot") {
  if (mode === "file") return import(pathToFileURL(sourcePath).href);
  if (mode !== "snapshot") throw new Error(`Unsupported glue execution mode: ${mode}`);
  return import(`data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`);
}
