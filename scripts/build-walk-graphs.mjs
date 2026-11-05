#!/usr/bin/env node
// Build per-city pedestrian graphs (PTWG v2) from the
// cached Geofabrik extracts in .poi-pbf-cache/.
//
//   node scripts/build-walk-graphs.mjs [--cities vilnius,tricity] [--require]
//        [--out <dir>] [--raw-out <dir>] [--bin <pt-walk-build>]
//   node scripts/build-walk-graphs.mjs --fetch-missing [--cities ...]
//
// --fetch-missing downloads every listed city's extract that no cache dir
// holds into .osm-pbf-cache/ and builds nothing (CI runs it before saving
// that cache).
//
// Without --cities, every city whose PBF is cached is built and the rest are
// skipped with a warning. With --require, a listed city whose PBF is missing
// is an error (the production image build sets it).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// .poi-pbf-cache holds the POI cities' extracts (cityProfiles.ts);
// .osm-pbf-cache the rest (krakow, oslo), fetched by --fetch-missing.
// PT_PBF_DIRS (colon-separated) overrides both, e.g. for a bind-mounted
// build context.
export const PBF_DIRS = process.env.PT_PBF_DIRS
  ? process.env.PT_PBF_DIRS.split(":").filter(Boolean)
  : [join(REPO_ROOT, ".poi-pbf-cache"), join(REPO_ROOT, ".osm-pbf-cache")];
const DEFAULT_OUT = join(REPO_ROOT, "packages/frontend/public/walk-graph");
const DEFAULT_BIN = join(REPO_ROOT, "target/release/pt-walk-build");

// The app's bbox from packages/frontend/src/config/cities.ts, padded 0.03°
// (~2-3 km) on every side so a walk that starts at the map edge still finds
// the network. The test asserts each box contains the app's.
export const CITIES = JSON.parse(readFileSync(new URL("../config/osm-cities.json", import.meta.url), "utf8"));

// Must equal WALK_HIGHWAYS in crates/pt-walk/src/osm.rs (the test checks).
export const WALK_HIGHWAYS = [
  "footway", "path", "pedestrian", "steps", "track", "sidewalk", "crossing", "living_street",
  "residential", "unclassified", "service", "tertiary", "tertiary_link", "secondary",
  "secondary_link", "primary", "primary_link", "cycleway", "bridleway",
];

export const EXPORT_CONFIG = {
  attributes: { type: false, id: false },
  linear_tags: true,
  area_tags: false,
  include_tags: ["highway", "name", "footway", "access", "foot"],
};

// First cached copy of the city's extract; the last dir's path when none is.
export function pbfCachePath(cityId, dirs = PBF_DIRS) {
  const name = basename(new URL(CITIES[cityId].pbf).pathname);
  const paths = dirs.map((d) => join(d, name));
  return paths.find((p) => existsSync(p)) ?? paths[paths.length - 1];
}

export function osmiumCommands(cityId, pbfPath, workDir) {
  const clipped = join(workDir, "clipped.osm.pbf");
  const ways = join(workDir, "ways.osm.pbf");
  return [
    ["extract", "--strategy=complete_ways", "--bbox", CITIES[cityId].bbox.join(","), pbfPath, "-o", clipped, "--overwrite"],
    ["tags-filter", clipped, `w/highway=${WALK_HIGHWAYS.join(",")}`, "-o", ways, "--overwrite"],
    [
      "export", ways, "-f", "geojsonseq", "--geometry-types=linestring",
      "-c", join(workDir, "export.json"), "-o", join(workDir, "ways.geojsonseq"), "--overwrite",
    ],
  ];
}

export function compressArtifact(raw) {
  return brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

export function parseArgs(argv) {
  const args = { cities: null, require: false, fetchMissing: false, out: DEFAULT_OUT, rawOut: null, generatedAt: null, bin: process.env.PT_WALK_BUILD ?? DEFAULT_BIN };
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
    else if (flag === "--fetch-missing") args.fetchMissing = true;
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--raw-out") args.rawOut = resolve(value());
    else if (flag === "--generated-at") {
      args.generatedAt = value();
      if (!Number.isFinite(Date.parse(args.generatedAt))) throw new Error("invalid source timestamp");
    }
    else if (flag === "--bin") args.bin = resolve(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${argv[0]} exited ${r.status}`);
  return r.stdout;
}

function buildCity(cityId, pbfPath, args) {
  const work = mkdtempSync(join(tmpdir(), `walk-graph-${cityId}-`));
  try {
    writeFileSync(join(work, "export.json"), JSON.stringify(EXPORT_CONFIG));
    for (const argv of osmiumCommands(cityId, pbfPath, work)) run("osmium", argv);
    const generatedAt = (args.generatedAt ?? statSync(pbfPath).mtime.toISOString()).slice(0, 10);
    const raw = join(work, `${cityId}.ptwg`);
    const stats = JSON.parse(
      run(args.bin, [
        "--input", join(work, "ways.geojsonseq"), "--city", cityId,
        "--generated-at", generatedAt, "--out", raw, "--source", `openstreetmap:${basename(pbfPath)}`,
      ]),
    );
    const bytes = readFileSync(raw);
    const br = compressArtifact(bytes);
    mkdirSync(args.out, { recursive: true });
    const finalPath = join(args.out, `${cityId}.ptwg.br`);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, br);
    renameSync(tmpPath, finalPath);
    if (args.rawOut) {
      mkdirSync(args.rawOut, { recursive: true });
      writeFileSync(join(args.rawOut, `${cityId}.ptwg`), bytes);
    }
    console.log(JSON.stringify({ ...stats, brotli_bytes: br.length }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function fetchMissing(cities, { dirs = PBF_DIRS, download = run } = {}) {
  for (const cityId of cities) {
    const dest = pbfCachePath(cityId, dirs);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.part`;
    console.log(`fetching ${CITIES[cityId].pbf} for ${cityId}`);
    try {
      // curl's default retry policy excludes TLS read failures (exit 56).
      // --output lets curl truncate partial bytes before each retry:
      // https://curl.se/docs/manpage.html#--retry-all-errors
      download("curl", ["-sSfL", "--retry", "3", "--retry-all-errors", "--retry-delay", "5", "-o", tmp, CITIES[cityId].pbf]);
      renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.fetchMissing) return fetchMissing(args.cities ?? Object.keys(CITIES));
  if (!existsSync(args.bin)) throw new Error(`pt-walk-build not found at ${args.bin} (cargo build --release -p pt-walk --features build)`);
  const wanted = args.cities ?? Object.keys(CITIES);
  let built = 0;
  for (const cityId of wanted) {
    if (CITIES[cityId].walkGraph === false) {
      if (args.require && args.cities) throw new Error(`walk graph for ${cityId} requires tiling within the native point cap`);
      console.warn(`walk graph for ${cityId} is unsupported until tiled; skipping`);
      continue;
    }
    const pbfPath = pbfCachePath(cityId);
    if (!existsSync(pbfPath)) {
      if (args.require) throw new Error(`walk graph for ${cityId} is required but ${pbfPath} is missing`);
      console.warn(`WARNING: ${pbfPath} missing — skipping walk graph for ${cityId}; the app draws straight walk legs there.`);
      continue;
    }
    buildCity(cityId, pbfPath, args);
    built++;
  }
  if (args.require && built === 0) throw new Error("no walk graphs built");
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) {
  try {
    main();
  } catch (err) {
    console.error(`build-walk-graphs: ${err.message}`);
    process.exit(1);
  }
}
