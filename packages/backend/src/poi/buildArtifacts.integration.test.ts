import { it, expect } from "vitest";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildReleases } from "./buildArtifacts.js";
import { refreshSnapshot } from "./sourceSnapshot.js";

// Explicit tool-chain gate, separate from application-only tests. The artifact
// publication workflow must enable it after building the native tools.
it.runIf(process.env.PT_OSM_BUILDER_INTEGRATION === "1")("builds, signs, installs and consumes a real tiny PBF", async () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const tools = process.env.PT_OSM_TEST_TOOL_DIR ?? join(root, "target/debug");
  for (const tool of ["pt-producer", "pt-walk-build", "pt-artifact-publish", "pt-artifacts"]) {
    if (!existsSync(join(tools, tool))) throw new Error(`build native artifact tools first: ${tool}`);
  }
  const work = await mkdtemp(join(tmpdir(), "ptn-real-osm-"));
  const command = (program: string, args: string[], env = process.env) => {
    const result = spawnSync(program, args, { encoding: "utf8", env, timeout: 30_000 });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    const xml = join(work, "source.osm");
    const pbf = join(work, "source.osm.pbf");
    await writeFile(xml, `<osm version="0.6" generator="ptn-test">
      <node id="1" version="1" lat="54.6900" lon="25.2800"/>
      <node id="2" version="1" lat="54.6905" lon="25.2805"/>
      <node id="3" version="1" lat="54.6910" lon="25.2810"/>
      <node id="4" version="1" lat="54.6905" lon="25.2805"><tag k="addr:street" v="Fixture street"/><tag k="addr:housenumber" v="1"/><tag k="amenity" v="cafe"/><tag k="name" v="Fixture Cafe"/></node>
      <way id="10" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="footway"/><tag k="name" v="Fixture path"/></way>
    </osm>`);
    const sourceAt = new Date(Math.floor((Date.now() - 86400_000) / 1000) * 1000).toISOString();
    command("osmium", ["cat", xml, "-o", pbf, `--output-header=osmosis_replication_timestamp=${sourceAt}`]);
    const seed = Buffer.alloc(32, 17); // Fixed, public test key only.
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const signingKey = join(work, "seed"); await writeFile(signingKey, seed.toString("hex"), { mode: 0o600 });
    const data = new Uint8Array(await readFile(pbf));
    const repository = join(work, "repository");
    const result = await buildReleases({
      cities: ["vilnius"], workDir: join(work, "build"), repository, signingKey, trustedKeys: [publicKey], revision: "real-tool-fixture",
      producer: join(tools, "pt-producer"), walkBuilder: join(tools, "pt-walk-build"), publisher: join(tools, "pt-artifact-publish"),
    }, { snapshot: (url, cache) => refreshSnapshot(url, cache, { fetch: (async () => new Response(data)) as typeof fetch }) });
    expect(result.vilnius.error).toBeUndefined();
    const release = result.vilnius.release!;
    const manifest = JSON.parse(await readFile(join(repository, "releases", release, "manifest.json"), "utf8"));
    expect(manifest.source.snapshotAt).toBe(sourceAt);
    for (const name of ["walking", "addresses", "walkGraph", "poi"]) expect(manifest.components[name].status).toBe("present");

    const installed = join(work, "installed"); const config = join(work, "manager.json");
    await writeFile(config, JSON.stringify({ root: installed, source: { kind: "local", directory: repository }, trustedKeys: [publicKey], cities: { vilnius: {} } }));
    command(join(tools, "pt-artifacts"), ["--config", config, "sync"]);
    const state = JSON.parse(command(join(tools, "pt-artifacts"), ["--config", config, "status"]));
    expect(state.vilnius.release).toBe(release);
    expect(existsSync(join(installed, "public/releases", release, "walk-graph.ptwg.br"))).toBe(true);
    expect(existsSync(join(installed, "public/releases", release, "private"))).toBe(false);

    const transit = join(work, "transit"); await mkdir(transit); await writeFile(join(transit, "pt-serve.version"), "2\n");
    command(join(tools, "pt-producer"), ["republish", "--data-root", transit, "--city", "vilnius", "--from-cache", join(root, "crates/pt-producer/tests/fixtures/tiny-gtfs.zip"), "--anchor-date", "20260501", "--city-tz-iana", "Europe/Vilnius", "--osm-artifact-root", installed], { ...process.env, PT_COLOR_BUILD: "rust", PT_TILE_BUILD: "rust" });
    const current = JSON.parse(await readFile(join(transit, "current.json"), "utf8"));
    const generation = join(transit, "generations", current.generationId);
    const published = JSON.parse(await readFile(join(generation, "generation.json"), "utf8"));
    expect(published.manifestSchemaVersion).toBe(2);
    expect(published.generationId).not.toBe(published.bundleSha256);
    expect(published.hasTransfers).toBe(true);
    expect(existsSync(join(generation, "address-search.fst"))).toBe(true);

    // A clean producer starts before its manager has installed required data.
    // Keep the normal hourly interval: late data must be retried promptly.
    const lateTransit = join(work, "late-transit");
    const lateArtifacts = join(work, "late-artifacts");
    await mkdir(lateTransit);
    await writeFile(join(lateTransit, "pt-serve.version"), "2\n");
    const child = spawn(join(tools, "pt-producer"), [
      "periodic-refresh", "--data-root", lateTransit, "--city", "vilnius",
      "--gtfs", join(root, "crates/pt-producer/tests/fixtures/tiny-gtfs.zip"),
      "--anchor-date", "20260501", "--city-tz-iana", "Europe/Vilnius",
      "--osm-artifact-root", lateArtifacts, "--refresh-interval-secs", "3600",
      "--liveness-listen-addr", "127.0.0.1:0",
    ], {env: {...process.env, PT_COLOR_BUILD: "rust", PT_TILE_BUILD: "rust"}, stdio: ["ignore", "ignore", "pipe"]});
    let logs = "";
    child.stderr.on("data", bytes => { logs += String(bytes); });
    const exited = new Promise<void>(done => child.once("exit", () => done()));
    const waitFor = async (condition: () => boolean, timeout: number) => {
      const deadline = Date.now() + timeout;
      while (!condition() && Date.now() < deadline && child.exitCode === null) {
        await new Promise(done => setTimeout(done, 50));
      }
      expect(condition(), logs).toBe(true);
    };
    try {
      await waitFor(() => logs.includes("required OSM inputs unavailable"), 10_000);
      expect(existsSync(join(lateTransit, "current.json"))).toBe(false);
      await symlink(installed, lateArtifacts);
      await waitFor(() => existsSync(join(lateTransit, "current.json")), 40_000);
      const lateCurrent = JSON.parse(await readFile(join(lateTransit, "current.json"), "utf8"));
      expect(existsSync(join(lateTransit, "generations", lateCurrent.generationId, "address-search.fst"))).toBe(true);
    } finally {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killTimer);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
}, 90_000);
