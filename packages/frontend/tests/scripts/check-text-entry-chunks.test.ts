import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs build script, no type declarations
import { checkTextEntryChunks, staticImports } from "../../scripts/check-text-entry-chunks.mjs";

let dist: string;

async function put(name: string, content: string): Promise<void> {
  await writeFile(join(dist, "assets", name), content);
}

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), "text-entry-chunks-"));
  await mkdir(join(dist, "assets"));
  await writeFile(
    join(dist, "index.html"),
    '<script type="module" crossorigin src="/assets/index-AAA.js"></script>',
  );
});

afterEach(async () => {
  await rm(dist, { recursive: true, force: true });
});

describe("check-text-entry-chunks", () => {
  it("reads static imports but not dynamic ones", () => {
    const source =
      'import"./a-1.js";import{x as y}from"./b-2.js";export{z}from"./c-3.js";const m=()=>import("./vendor-map-4.js");';
    expect(staticImports(source)).toEqual(["a-1.js", "b-2.js", "c-3.js"]);
  });

  it("passes when the map is only reachable through import()", async () => {
    await put("index-AAA.js", 'import{a}from"./vendor-react-1.js";const h=()=>import("./HomeDispatcher-2.js");');
    await put("vendor-react-1.js", "export const a=1;");
    await put("HomeDispatcher-2.js", 'import"./vendor-react-1.js";const t=()=>import("./TextHome-3.js");const m=()=>import("./Home-4.js");');
    await put("TextHome-3.js", "export const t=1;");
    await put("Home-4.js", 'import{M}from"./vendor-map-5.js";');
    await put("vendor-map-5.js", "export const M=1;");
    const result = checkTextEntryChunks(join(dist, "assets"));
    expect(result.offending).toEqual([]);
    expect(result.reached).not.toContain("Home-4.js");
  });

  it("fails when Text home statically reaches vendor-map", async () => {
    await put("index-AAA.js", "export const a=1;");
    await put("HomeDispatcher-2.js", "export const d=1;");
    await put("TextHome-3.js", 'import{s}from"./shared-6.js";');
    await put("shared-6.js", 'import{M}from"./vendor-map-5.js";export const s=1;');
    await put("vendor-map-5.js", "export const M=1;");
    expect(checkTextEntryChunks(join(dist, "assets")).offending).toEqual(["vendor-map-5.js"]);
  });
});
