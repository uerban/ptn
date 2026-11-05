import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
// @ts-expect-error -- plain .mjs build script, no type declarations
import { precompressDist } from "../../scripts/precompress-dist.mjs";

let dist: string;

const compressible = (label: string): string => `/* ${label} */\n${"export const route = 'Vilnius';\n".repeat(200)}`;

async function put(path: string, content: string | Uint8Array): Promise<void> {
  const full = join(dist, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), "precompress-dist-"));
});

afterEach(async () => {
  await rm(dist, { recursive: true, force: true });
});

describe("precompressDist", () => {
  it("writes .br and .gz variants that decode back to the source", async () => {
    const js = compressible("entry");
    await put("assets/index-abc.js", js);
    await put("assets/index-abc.css", compressible("css"));
    await put("assets/pt_wasm_bg-abc.wasm", compressible("wasm"));
    await put("glyphs/Open Sans Regular/0-255.pbf", compressible("glyph"));

    await precompressDist(dist);

    const br = await readFile(join(dist, "assets/index-abc.js.br"));
    const gz = await readFile(join(dist, "assets/index-abc.js.gz"));
    expect(brotliDecompressSync(br).toString()).toBe(js);
    expect(gunzipSync(gz).toString()).toBe(js);
    expect(br.length).toBeLessThan(js.length);
    for (const path of [
      "assets/index-abc.css",
      "assets/pt_wasm_bg-abc.wasm",
      "glyphs/Open Sans Regular/0-255.pbf",
    ]) {
      await expect(readFile(join(dist, `${path}.br`))).resolves.toBeTruthy();
      await expect(readFile(join(dist, `${path}.gz`))).resolves.toBeTruthy();
    }
  });

  it("only touches the target directories and extensions nginx looks in", async () => {
    await put("assets/font-abc.woff2", compressible("font"));
    await put("index.html", compressible("html"));
    await put("sw.js", compressible("sw"));
    await put("glyphs/README.md", compressible("readme"));
    await put("micromap/vilnius.micromap.br", compressible("micromap"));

    await precompressDist(dist);

    const all = await readdir(dist, { recursive: true });
    expect(all.filter((p) => /\.(br|gz)$/.test(p))).toEqual(["micromap/vilnius.micromap.br"]);
  });

  it("skips a variant that is not smaller than its source", async () => {
    await put("assets/tiny-abc.js", "x");

    await precompressDist(dist);

    const assets = await readdir(join(dist, "assets"));
    expect(assets).toEqual(["tiny-abc.js"]);
  });

  it("is idempotent: a second run neither compresses variants nor changes them", async () => {
    await put("assets/index-abc.js", compressible("entry"));
    await precompressDist(dist);
    const first = await readFile(join(dist, "assets/index-abc.js.br"));

    await precompressDist(dist);

    expect((await readdir(join(dist, "assets"))).sort()).toEqual([
      "index-abc.js",
      "index-abc.js.br",
      "index-abc.js.gz",
    ]);
    expect(await readFile(join(dist, "assets/index-abc.js.br"))).toEqual(first);
  });

  it("tolerates a dist without glyphs", async () => {
    await put("assets/index-abc.js", compressible("entry"));
    await expect(precompressDist(dist)).resolves.toHaveLength(1);
  });
});
