#!/usr/bin/env node
// Bundle optional local-data tooling. No node_modules or compiler is needed
// on a release host: only Node 22+ and osmium-tool, plus the native tools.
import {createRequire} from "node:module";
import {cp, mkdir} from "node:fs/promises";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const frontendRequire = createRequire(resolve(root, "packages/frontend/package.json"));
const {build} = createRequire(frontendRequire.resolve("vite"))("esbuild");
const out = resolve(root, "release-builder");
const entries = [
  ["packages/backend/src/poi/buildArtifacts.ts", "packages/backend/src/poi/buildArtifacts.mjs"],
  ["packages/backend/scripts/extract-addr-fixture.ts", "packages/backend/scripts/extract-addr-fixture.mjs"],
];
for (const [entry, output] of entries) {
  await build({entryPoints: [resolve(root, entry)], outfile: resolve(out, output),
    bundle: true, platform: "node", format: "esm", target: "node22",
    banner: {js: 'import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);'},
  });
}
for (const path of ["scripts/build-city-osm-artifacts.mjs", "scripts/build-walk-graphs.mjs", "config/osm-cities.json", "packages/backend/src/poi/osmTags.yaml"]) {
  await mkdir(resolve(out, path, ".."), {recursive: true});
  await cp(resolve(root, path), resolve(out, path));
}
