#!/usr/bin/env node
// Build the per-city OSM inputs pt-producer reads through --city-osm-dir:
//
//   <out>/<city>/walking.geojsonseq.gz  walkable ways; the producer builds the
//                                       stop-to-stop transfer table (PTFT)
//                                       from it for every generation
//   <out>/<city>/address-search.fst     packed address corpus (PTAS)
//
//   node scripts/build-city-osm-artifacts.mjs [--cities vilnius,tricity] [--require]
//        [--out <dir>] [--producer <pt-producer>] [--intermediate]
//
// --intermediate writes address-search.json (the extractor's output) instead
// of packing it. CI runs that mode, where osmium lives; the backend image
// packs the JSON with its own pt-producer, so the packed format always
// matches the binary that serves it.
//
// Cities, bboxes and extracts are the walk-graph ones (build-walk-graphs.mjs),
// so the transfer table and the drawn walk legs come from the same ways.
// Without --cities every city whose extract is cached is built; with
// --require a listed city whose extract is missing is an error.

import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { CITIES, EXPORT_CONFIG, osmiumCommands, pbfCachePath } from "./build-walk-graphs.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACT_SCRIPT = process.env.PT_ADDRESS_EXTRACT_SCRIPT ?? join(REPO_ROOT, "packages/backend/scripts/extract-addr-fixture.ts");
const LOCAL_TSX = join(REPO_ROOT, "packages/backend/node_modules/.bin/tsx");

export const WALKING_GRAPH_FILE = "walking.geojsonseq.gz";
export const ADDRESS_SEARCH_FILE = "address-search.fst";
export const ADDRESS_INTERMEDIATE_FILE = "address-search.json";

export function parseArgs(argv) {
  const args = {
    cities: null,
    require: false,
    intermediate: false,
    out: join(REPO_ROOT, "data/city-osm"),
    producer: process.env.PT_PRODUCER ?? join(REPO_ROOT, "target/release/pt-producer"),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--cities") {
      args.cities = value().split(",").filter(Boolean);
      for (const c of args.cities) if (!(c in CITIES)) throw new Error(`unknown city ${c}`);
    } else if (flag === "--require") args.require = true;
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--producer") args.producer = resolve(value());
    else if (flag === "--intermediate") args.intermediate = true;
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

// osmium's bbox order is minLon,minLat,maxLon,maxLat; so is the extractor's.
export function addressExtractArgs(cityId, pbfPath, outJson) {
  return [EXTRACT_SCRIPT, pbfPath, ...CITIES[cityId].bbox.map(String), outJson, cityId];
}

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${argv[0]} exited ${r.status}`);
}

async function buildCity(cityId, pbfPath, args) {
  const work = mkdtempSync(join(tmpdir(), `city-osm-${cityId}-`));
  try {
    writeFileSync(join(work, "export.json"), JSON.stringify(EXPORT_CONFIG));
    for (const argv of osmiumCommands(cityId, pbfPath, work)) run("osmium", argv);

    const dir = join(args.out, cityId);
    mkdirSync(dir, { recursive: true });
    const graph = join(dir, WALKING_GRAPH_FILE);
    await pipeline(createReadStream(join(work, "ways.geojsonseq")), createGzip({ level: 9 }), createWriteStream(`${graph}.tmp`));
    renameSync(`${graph}.tmp`, graph);

    // The extractor reads the bbox-clipped extract, not the regional one:
    // same features inside the box, a fraction of the memory.
    const json = join(work, "address.json");
    const tsx = EXTRACT_SCRIPT.endsWith(".mjs") ? process.execPath : (existsSync(LOCAL_TSX) ? LOCAL_TSX : "tsx");
    run(tsx, addressExtractArgs(cityId, join(work, "clipped.osm.pbf"), json));
    let address;
    if (args.intermediate) {
      address = join(dir, ADDRESS_INTERMEDIATE_FILE);
      await pipeline(createReadStream(json), createWriteStream(`${address}.tmp`));
    } else {
      address = join(dir, ADDRESS_SEARCH_FILE);
      run(args.producer, ["pack-address-search", "--input", json, "--out", `${address}.tmp`, "--city", cityId]);
    }
    renameSync(`${address}.tmp`, address);

    console.log(JSON.stringify({ city: cityId, walking_graph_bytes: statSync(graph).size, address_bytes: statSync(address).size }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.intermediate && !existsSync(args.producer)) throw new Error(`pt-producer not found at ${args.producer}`);
  const wanted = args.cities ?? Object.keys(CITIES);
  let built = 0;
  for (const cityId of wanted) {
    const pbfPath = pbfCachePath(cityId);
    if (!existsSync(pbfPath)) {
      if (args.require) throw new Error(`city OSM artifacts for ${cityId} are required but ${pbfPath} is missing`);
      console.warn(`WARNING: ${pbfPath} missing — skipping ${cityId}; its producer publishes without transfers or address search.`);
      continue;
    }
    await buildCity(cityId, pbfPath, args);
    built++;
  }
  if (args.require && built === 0) throw new Error("no city OSM artifacts built");
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error(`build-city-osm-artifacts: ${err.message}`);
    process.exit(1);
  });
}
