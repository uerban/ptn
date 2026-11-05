#!/usr/bin/env node
// Writes a brotli (`.br`, quality 11) and a gzip (`.gz`, level 9) copy next to
// every compressible static file the frontend nginx serves from disk, so it
// sends build-time bytes instead of compressing on the fly. On-the-fly gzip
// runs at nginx's default level 1, which Cloudflare passed through as is: the
// entry chunk went out at 129 kB where brotli 11 is 95 kB.
//
// nginx.conf picks the variant: `.br` through try_files when the client
// accepts brotli (stock nginx:alpine has no brotli module), `.gz` through
// gzip_static otherwise.
//
// Runs after `vite build`, so the PWA precache manifest never lists the
// variants. A variant that is not smaller than its source is not written, and
// nginx then serves the source.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants } from "node:zlib";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/**
 * Directories under dist/ and the extensions compressed in each. Keep in step
 * with the precompressed `location` blocks in packages/frontend/nginx.conf: a
 * variant nginx never looks for is dead weight, and a location that expects
 * variants this script does not write falls back to the uncompressed file.
 */
export const PRECOMPRESS_TARGETS = [
  { dir: "assets", extensions: [".js", ".css", ".wasm"] },
  { dir: "glyphs", extensions: [".pbf"] },
];

const TEXT_EXTENSIONS = new Set([".js", ".css"]);

async function listFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

async function compressFile(path) {
  const source = await readFile(path);
  const [br, gzipped] = await Promise.all([
    brotli(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: TEXT_EXTENSIONS.has(extensionOf(path))
          ? constants.BROTLI_MODE_TEXT
          : constants.BROTLI_MODE_GENERIC,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }),
    gz(source, { level: constants.Z_BEST_COMPRESSION }),
  ]);
  const written = { path, source: source.length, br: null, gz: null };
  if (br.length < source.length) {
    await writeFile(`${path}.br`, br);
    written.br = br.length;
  }
  if (gzipped.length < source.length) {
    await writeFile(`${path}.gz`, gzipped);
    written.gz = gzipped.length;
  }
  return written;
}

/** Compress every target file under `distDir`; returns one record per file. */
export async function precompressDist(distDir, targets = PRECOMPRESS_TARGETS) {
  const files = [];
  for (const { dir, extensions } of targets) {
    for (const path of await listFiles(join(distDir, dir))) {
      if (extensions.includes(extensionOf(path))) files.push(path);
    }
  }
  return Promise.all(files.map(compressFile));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const distDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
  const results = await precompressDist(distDir);
  const sum = (key) => results.reduce((total, r) => total + (r[key] ?? r.source), 0);
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  console.log(
    `precompress-dist: ${results.length} files, ${kb(sum("source"))} -> br ${kb(sum("br"))}, gz ${kb(sum("gz"))}`,
  );
}
