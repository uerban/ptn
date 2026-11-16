import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (digest) => {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact digest");
};

/** No cleanup: every retained run keeps its artifact references indefinitely. */
export function retainArtifact(root, bytes) {
  const digest = hash(bytes);
  const directory = join(root, "artifacts");
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(join(directory, digest), bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    readArtifact(root, digest); // Never accept a corrupted existing object.
  }
  return digest;
}

export function readArtifact(root, digest) {
  validHash(digest);
  const bytes = readFileSync(join(root, "artifacts", digest));
  if (hash(bytes) !== digest) throw new Error(`Artifact integrity mismatch: ${digest}`);
  return bytes;
}

/** Run IDs are local names, never paths; existing records cannot be replaced. */
export function retainRun(root, id, record) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid run ID");
  if (record.schemaVersion !== 1 || !record.artifacts || typeof record.artifacts !== "object") {
    throw new Error("Invalid run manifest");
  }
  for (const digest of Object.values(record.artifacts)) readArtifact(root, digest);
  const directory = join(root, "runs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}
