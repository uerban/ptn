#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CITIES, compressArtifact, pbfCachePath } from "./build-walk-graphs.mjs";
import { buildMicromap } from "./lib/micromap/build.mjs";

const FAMILIES = {
  roads: ["linestring", "w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link"],
  waterways: ["linestring", "w/waterway=river,canal,stream"],
  water: ["polygon", "wr/natural=water", "wr/landuse=reservoir,basin", "wr/waterway=riverbank"],
  green: ["polygon", "wr/leisure=park", "wr/landuse=forest,grass,meadow,village_green,recreation_ground", "wr/natural=wood,scrub"],
  places: ["point", "n/place=city,town,borough,suburb,quarter,village,neighbourhood"],
};

function osmium(args) {
  const result = spawnSync("osmium", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`osmium ${args[0]} failed (${result.signal ?? result.status})`);
}

async function readFeatures(path) {
  const features = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const feature = line.replace(/^\x1e/, "").trim();
    if (feature) features.push(JSON.parse(feature));
  }
  return features;
}

/** Build the app's static map asset from an already clipped city PBF. */
export async function writeMicromap(cityId, clipped, workDir, out, generatedAt) {
  const features = {};
  for (const [family, [geometry, ...filters]] of Object.entries(FAMILIES)) {
    const filtered = join(workDir, `micromap-${family}.osm.pbf`);
    const exported = join(workDir, `micromap-${family}.geojsonseq`);
    osmium(["tags-filter", clipped, ...filters, "-o", filtered]);
    osmium(["export", filtered, "-f", "geojsonseq", `--geometry-types=${geometry}`, "-o", exported]);
    features[family] = await readFeatures(exported);
  }

  const { artifact, stats } = buildMicromap({ cityId, bbox: CITIES[cityId].bbox, generatedAt, features });
  const compressed = compressArtifact(Buffer.from(JSON.stringify(artifact)));
  await mkdir(out, { recursive: true });
  const path = join(out, `${cityId}.micromap.br`);
  const staging = await mkdtemp(join(out, ".micromap-"));
  try {
    const temporary = join(staging, "artifact.br");
    await writeFile(temporary, compressed);
    await rename(temporary, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { city: cityId, path, counts: stats.counts, brotli_bytes: compressed.length };
}

async function main() {
  const [cityId, out, ...extra] = process.argv.slice(2);
  if (!Object.hasOwn(CITIES, cityId) || !out || extra.length) {
    throw new Error("usage: node scripts/build-micromap.mjs <city> <output-directory>");
  }
  const pbf = pbfCachePath(cityId);
  if (!pbf || !existsSync(pbf)) throw new Error(`missing OSM extract for ${cityId}: ${pbf}`);
  const workDir = await mkdtemp(join(tmpdir(), `micromap-${cityId}-`));
  try {
    const clipped = join(workDir, "clipped.osm.pbf");
    osmium(["extract", "--strategy=smart", "--bbox", CITIES[cityId].bbox.join(","), pbf, "-o", clipped]);
    const generatedAt = (await stat(pbf)).mtime.toISOString().slice(0, 10);
    console.log(JSON.stringify(await writeMicromap(cityId, clipped, workDir, resolve(out), generatedAt)));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`build-micromap: ${error.message}`);
    process.exitCode = 1;
  });
}
