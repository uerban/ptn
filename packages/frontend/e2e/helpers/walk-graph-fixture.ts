import {expect, type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {brotliCompressSync} from "node:zlib";

// Actual compiled pedestrian graph, not an injected route response. Regenerate:
// cargo run -p pt-walk --features build --bin pt-walk-build -- --input
// crates/pt-walk/tests/fixtures/tiny.geojsonseq --city vilnius
// --generated-at 2026-10-26 --out packages/frontend/e2e/fixtures/tiny-walk.ptwg
const graph = readFileSync(new URL("../fixtures/tiny-walk.ptwg", import.meta.url));
const compressed = brotliCompressSync(graph);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifest = Buffer.from(JSON.stringify({schemaVersion: 1, city: "vilnius", components: {
  walkGraph: {status: "present", format: "ptwg", formatVersion: 2, compression: "brotli",
    sha256: hash(compressed), bytes: compressed.length, decodedBytes: graph.length},
}}));
export const WALK_FIXTURE_RELEASE = hash(manifest);
const release = WALK_FIXTURE_RELEASE;


export async function mockWalkGraph(page: Page): Promise<string[]> {
  const requests: string[] = [];
  // Context routing includes worker-origin requests in the built PWA.
  await page.context().route("**/osm/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    expect(url.search).toBe("");
    expect(route.request().method()).toBe("GET");
    expect(route.request().postData()).toBeNull();
    const path = url.pathname;
    if (path === "/osm/current/vilnius.json") {
      await route.fulfill({json: {schemaVersion: 1, release, revision: 1}});
    } else if (path === `/osm/releases/${release}/manifest.json`) {
      await route.fulfill({body: manifest, contentType: "application/json"});
    } else if (path === `/osm/releases/${release}/walk-graph.ptwg.br`) {
      await route.fulfill({body: compressed, contentType: "application/octet-stream"});
    } else await route.fulfill({status: 404});
  });
  return requests;
}
