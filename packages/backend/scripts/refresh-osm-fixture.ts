// Download the live Vilnius source extract through the production snapshot
// path, then clip it to the city's bounding box. The clip is the pinned input
// that release validation builds from, so releases never wait on the upstream
// OSM mirror. Usage: tsx scripts/refresh-osm-fixture.ts <work-dir> <out.osm.pbf>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CITY_SPECS } from "../src/poi/buildArtifacts.js";
import { inspectPbf, refreshSnapshot } from "../src/poi/sourceSnapshot.js";

const [work, out] = process.argv.slice(2).map((arg) => resolve(arg));
if (!work || !out) throw new Error("usage: refresh-osm-fixture.ts <work-dir> <out.osm.pbf>");
const spec = CITY_SPECS.vilnius;
const snapshot = await refreshSnapshot(spec.pbf, work);
console.log(`source ${spec.pbf} sha256=${snapshot.sha256} bytes=${snapshot.bytes} snapshotAt=${snapshot.snapshotAt}`);

// A small margin keeps ways that cross the city edge whole for the builder's
// own clip.
const [minLon, minLat, maxLon, maxLat] = spec.bbox;
const pad = 0.02;
const bbox = [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad].join(",");
// osmium does not carry header options into the extract; restate the
// upstream replication timestamp so the clip stays a dated snapshot.
const stamp = snapshot.snapshotAt.replace(/\.\d{3}Z$/, "Z");
const clip = spawnSync("osmium", ["extract", "--strategy", "smart", "--bbox", bbox,
  "--output-header", `osmosis_replication_timestamp=${stamp}`, "--overwrite", "--output", out, snapshot.path], { stdio: "inherit" });
if (clip.status !== 0) throw new Error(`osmium extract failed (${clip.status})`);

const snapshotAt = inspectPbf(out);
if (snapshotAt !== snapshot.snapshotAt) throw new Error(`clip timestamp ${snapshotAt} differs from source ${snapshot.snapshotAt}`);
const sha256 = createHash("sha256").update(await readFile(out)).digest("hex");
const bytes = (await stat(out)).size;
console.log(JSON.stringify({ source: spec.pbf, sha256, bytes, snapshotAt }));
