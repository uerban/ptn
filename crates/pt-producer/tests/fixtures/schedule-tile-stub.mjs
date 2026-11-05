// Hermetic stub for the publish tests: emulates schedule-tile-gen.mjs's
// producer contract WITHOUT the backend build. It reads the staged
// generation.json for generationId (the real script's bundleHash source),
// writes a minimal <staging>/schedule-tiles/manifest.json, and prints the
// "schedule-tile-bundle <sha256-of-manifest.json> <bytes> <bundleHash>" line
// the producer parses. C4 (B4/B6): it also writes <staging>/trip-route.json +
// <staging>/stop-cell.json and prints their "<name> <sha256> <bytes>" lines,
// since the producer now requires those lines IFF the schedule-tile build ran.
// The publish test verifies the staging+manifest plumbing and the SHA
// cross-check, not the tile content (that's covered by the backend's
// schedule-tile-gen tests).
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const stagingDir = process.argv[2];
if (!stagingDir) {
  process.stderr.write("schedule-tile-stub: <staging-dir> required\n");
  process.exit(2);
}
// Mirror the real script: derive the bundleHash from the staged generation.json.
const generation = JSON.parse(readFileSync(join(stagingDir, "generation.json"), "utf8"));
const bundleHash = generation.generationId;
if (typeof bundleHash !== "string" || bundleHash.length === 0) {
  process.stderr.write("schedule-tile-stub: generation.json has no generationId\n");
  process.exit(2);
}
// Mirror the real script: a missing city env is a loud failure.
const cityId = process.env.PT_CITY_ID ?? process.env.CITY_ID;
if (!cityId) {
  process.stderr.write("schedule-tile-stub: PT_CITY_ID or CITY_ID must be set\n");
  process.exit(2);
}

const dataDir = join(stagingDir, "schedule-tiles");
mkdirSync(dataDir, { recursive: true });
const manifest = Buffer.from(
  JSON.stringify({ bundleHash, cityId, schemaVersion: 1, tiles: [] }),
  "utf8",
);
writeFileSync(join(dataDir, "manifest.json"), manifest);
const sha = createHash("sha256").update(manifest).digest("hex");
process.stdout.write(`schedule-tile-bundle ${sha} ${manifest.length} ${bundleHash}\n`);

// C4 (B4/B6) producer artifacts: written into the staging-dir ROOT (they ride
// the whole-dir rename), with a "<name> <sha256> <bytes>" line apiece — the
// producer's `validate_required` requires these whenever the bundle line printed.
function emitArtifact(name, body) {
  const buf = Buffer.from(body, "utf8");
  writeFileSync(join(stagingDir, `${name}.json`), buf);
  const h = createHash("sha256").update(buf).digest("hex");
  process.stdout.write(`${name} ${h} ${buf.length}\n`);
}
emitArtifact("trip-route", JSON.stringify({ routes: [], trips: {} }));
emitArtifact("stop-cell", JSON.stringify({}));
