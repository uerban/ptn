#!/usr/bin/env tsx
/** Independent, sequential OSM release builder. The downloading manager never
 * invokes this program. All components consume one checksum-frozen PBF per URL. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { LandmarkCityId } from "@pt/shared";
import { buildAll, checkSizeLimits } from "./buildAllBundles.js";
import { CITY_PROFILES } from "./cityProfiles.js";
import { refreshSnapshot, type SourceSnapshot } from "./sourceSnapshot.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
export interface CitySpec { pbf: string; bbox: [number, number, number, number]; poiCorpora: LandmarkCityId[]; walkGraph?: boolean; producerInputs?: boolean }
export const CITY_SPECS = JSON.parse(readFileSync(join(ROOT, "config/osm-cities.json"), "utf8")) as Record<string, CitySpec>;
type Component = { status: "present"; format: string; formatVersion: number; compression: string; sha256: string; bytes: number; decodedBytes: number } | { status: "unsupported" | "failed"; reason: string };

export interface BuilderConfig {
  cities: string[];
  workDir: string;
  repository: string;
  signingKey: string;
  trustedKeys: string[];
  revision: string;
  producer?: string;
  walkBuilder?: string;
  publisher?: string;
  cityTimeoutMs?: number;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 1800_000): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let failure: Error | undefined;
    const terminate = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } };
    const timer = setTimeout(() => { failure = new Error(`${command} exceeded build time limit`); terminate(); }, timeout);
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (kind === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > 16 * 1024 ** 2) { failure = new Error("build output limit exceeded"); terminate(); }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} ${args[0]} failed (${code}): ${stderr.slice(-8192)}`));
      if (stderr) process.stderr.write(stderr);
      resolveRun(stdout.trim());
    });
  });
}
async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function decodedGzipBytes(path: string): Promise<number> {
  let count = 0;
  for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    count += (chunk as Buffer).length;
    if (count > 4 * 1024 ** 3) throw new Error("walking input exceeds decoded size limit");
  }
  return count;
}

/** Injectable orchestration seams make source deduplication and per-city fault
 * isolation testable without large extracts or OSM tooling. Native byte checks
 * are still mandatory in the publisher, not replaced by these orchestration tests. */
export async function buildReleases(config: BuilderConfig, dependencies: {
  snapshot?: typeof refreshSnapshot;
  registry?: Record<string, CitySpec>;
  buildCity?: (city: string, snapshot: SourceSnapshot) => Promise<string>;
} = {}): Promise<Record<string, { release?: string; error?: string }>> {
  const registry = dependencies.registry ?? CITY_SPECS;
  if (!config.cities.length || config.cities.some((city) => !Object.hasOwn(registry, city))) throw new Error("select known deployment cities");
  if (!config.revision || !config.trustedKeys.length) throw new Error("builder revision and signing trust are required");
  await mkdir(config.workDir, { recursive: true });
  const sources = new Map<string, Promise<SourceSnapshot>>();
  const results: Record<string, { release?: string; error?: string }> = {};
  for (const city of new Set(config.cities)) {
    console.log(`[osm-builder] ${city}: starting`);
    const url = registry[city].pbf;
    try {
      if (!sources.has(url)) sources.set(url, (dependencies.snapshot ?? refreshSnapshot)(url, config.workDir));
      const snapshot = await sources.get(url)!;
      const release = dependencies.buildCity ? await dependencies.buildCity(city, snapshot) : await buildCity(config, city, snapshot);
      results[city] = { release };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results[city] = { error: reason };
      console.error(`[osm-builder] ${city}: ${reason}`);
    }
  }
  return results;
}

async function buildCity(config: BuilderConfig, city: string, snapshot: SourceSnapshot): Promise<string> {
  const spec = CITY_SPECS[city];
  const work = join(config.workDir, `build-${city}-${randomUUID()}`);
  const view = join(work, "pbf");
  const objects = join(work, "objects");
  await mkdir(view, { recursive: true }); await mkdir(objects);
  try {
    // A private view preserves the original filename for existing extract tools;
    // every view points to the same immutable, checksum-frozen source bytes.
    await link(snapshot.path, join(view, basename(new URL(snapshot.url).pathname)));
    const env = { ...process.env, PT_PBF_DIRS: view, TMPDIR: work };
    const producer = config.producer ?? join(ROOT, "target/release/pt-producer");
    const walkBuilder = config.walkBuilder ?? join(ROOT, "target/release/pt-walk-build");
    const publisher = config.publisher ?? join(ROOT, "target/release/pt-artifact-publish");
    const timeout = config.cityTimeoutMs ?? 1800_000;
    const tools = { osmium: (await run("osmium", ["--version"])).split("\n")[0], node: process.version };
    await run(process.execPath, [join(ROOT, "scripts/build-city-osm-artifacts.mjs"), "--cities", city, "--require", "--out", join(work, "inputs"), "--producer", producer], env, timeout);
    const components: Record<string, Component> = {};
    const add = async (name: string, path: string, format: string, version: number, compression: string, decodedBytes: number) => {
      const sha256 = await checksum(path);
      await copyFile(path, join(objects, sha256));
      components[name] = { status: "present", format, formatVersion: version, compression, sha256, bytes: (await stat(path)).size, decodedBytes };
    };
    const walking = join(work, "inputs", city, "walking.geojsonseq.gz");
    const addresses = join(work, "inputs", city, "address-search.fst");
    await add("walking", walking, "geojsonseq", 1, "gzip", await decodedGzipBytes(walking));
    await add("addresses", addresses, "ptas", 1, "none", (await stat(addresses)).size);
    if (spec.walkGraph === false) {
      components.walkGraph = {status: "unsupported", reason: "city graph requires tiling within the native point cap"};
    } else try {
      await run(process.execPath, [join(ROOT, "scripts/build-walk-graphs.mjs"), "--cities", city, "--require", "--out", join(work, "graphs"), "--raw-out", join(work, "raw-graphs"), "--bin", walkBuilder, "--generated-at", snapshot.snapshotAt], env, timeout);
      await add("walkGraph", join(work, "graphs", `${city}.ptwg.br`), "ptwg", 2, "brotli", (await stat(join(work, "raw-graphs", `${city}.ptwg`))).size);
    } catch (error) { components.walkGraph = { status: "failed", reason: error instanceof Error ? error.message : String(error) }; }

    if (spec.poiCorpora.length) {
      try {
        const poiDir = join(work, "poi");
        const job = join(work, "poi-job.json");
        await writeFile(job, JSON.stringify({ outputDir: poiDir, pbfCacheDir: view, cityIds: spec.poiCorpora, sourceSnapshots: { [snapshot.url]: snapshot }, emitTiles: false }));
        const runner = import.meta.filename.endsWith(".ts")
          ? join(ROOT, "packages/backend/node_modules/.bin/tsx") : process.execPath;
        await run(runner, [import.meta.filename, "--poi-job", job], env, timeout);
        const manifest = JSON.parse(await readFile(join(poiDir, "manifest.json"), "utf8")) as { bundles: { filename: string }[] };
        if (!manifest.bundles.length) throw new Error("POI corpus has no publishable bundles");
        const archive = join(work, "poi.tar");
        await run("tar", ["--format=ustar", "-cf", archive, "-C", poiDir, "manifest.json", ...manifest.bundles.map((b) => b.filename)], { ...env, COPYFILE_DISABLE: "1" }, timeout);
        const compressed = `${archive}.gz`;
        await pipeline(createReadStream(archive), createGzip({ level: 9 }), createWriteStream(compressed));
        await add("poi", compressed, "poi-corpus", 1, "gzip", (await stat(archive)).size);
      } catch (error) { components.poi = { status: "failed", reason: error instanceof Error ? error.message : String(error) }; }
    } else { components.poi = { status: "unsupported", reason: "no POI corpus configured for this city" }; }

    // Include the POI profile footprints: these can extend beyond the walk graph.
    const boxes = [spec.bbox, ...spec.poiCorpora.map((id) => { const b = CITY_PROFILES[id].bbox; return [b.minLon, b.minLat, b.maxLon, b.maxLat]; })];
    const bbox = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    const manifest = {
      schemaVersion: 1, city, coverageE5: bbox.map((n) => Math.round(n * 1e5)), createdAt: new Date().toISOString(),
      source: { url: snapshot.url, snapshotAt: snapshot.snapshotAt, sha256: snapshot.sha256 },
      builderRevision: config.revision, configurationSha256: createHash("sha256").update(JSON.stringify({ spec, poi: spec.poiCorpora.map((id) => CITY_PROFILES[id]) })).digest("hex"), tools,
      attribution: "© OpenStreetMap contributors", licenseUrl: "https://www.openstreetmap.org/copyright", components,
    };
    const path = join(work, "manifest.json"); await writeFile(path, JSON.stringify(manifest));
    return await run(publisher, ["--repository", config.repository, "--manifest", path, "--objects", objects, "--signing-key", config.signingKey, ...config.trustedKeys.flatMap((key) => ["--trusted-key", key])], env, timeout);
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]).replace(/\.(ts|js)$/, "") === resolve(import.meta.filename).replace(/\.(ts|js)$/, "")) {
  if (process.argv[2] === "--poi-job") {
    const options = JSON.parse(await readFile(process.argv[3], "utf8")) as Parameters<typeof buildAll>[0];
    const built = await buildAll(options);
    if (checkSizeLimits(built.bundles).length) throw new Error("POI size limits exceeded");
  } else {
    const file = process.argv[2];
    if (!file) throw new Error("usage: tsx buildArtifacts.ts <builder-config.json>");
    const config = JSON.parse(await readFile(file, "utf8")) as BuilderConfig;
    config.revision ||= process.env.PT_ARTIFACT_BUILDER_REVISION ?? "";
    const result = await buildReleases(config);
    console.log(JSON.stringify(result));
    if (Object.values(result).some((r) => r.error)) process.exitCode = 1;
  }
}
