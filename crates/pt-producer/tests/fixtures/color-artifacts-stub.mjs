// Hermetic stub for the publish tests: writes fixed {} artifacts + prints their shas.
// The publish test verifies the staging+manifest plumbing, not the color content
// (that's the parity gate's job). Keeps the producer test independent of the backend build.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const d = process.argv[2];
for (const n of ["color-config.json", "route-styles.json", "label-anchors.json"]) {
  const b = Buffer.from("{}", "utf8");
  writeFileSync(join(d, n), b);
  process.stdout.write(`${n} ${createHash("sha256").update(b).digest("hex")} ${b.length}\n`);
}
