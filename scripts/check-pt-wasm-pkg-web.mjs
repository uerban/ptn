#!/usr/bin/env node
// Verify that crates/pt-wasm/pkg-web holds real wasm-pack output before the
// frontend build tries to resolve `@pt/wasm` from it.
//
// The directory is a pnpm workspace member, but only its package.json is
// committed — the `main`/`types` files it points at are wasm-pack artifacts,
// produced by `.github/actions/setup-pt-wasm-pkg-web` in CI and by nothing at
// all locally. `pnpm install` links the package regardless, so a fresh clone
// or a new worktree installs cleanly and then dies deep inside rollup with
//
//     Failed to resolve entry for package "@pt/wasm"
//
// which names neither the real cause nor the fix. Same reasoning as the
// --syntax-only i18n preflight next to it in the frontend prebuild hook: fail
// early with the command to run, rather than late with a bundler stack trace.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_WEB_DIR = resolve(HERE, "..", "crates", "pt-wasm", "pkg-web");

export const BUILD_COMMAND =
  "cd crates/pt-wasm && wasm-pack build --release --target web --out-dir pkg-web";

/**
 * Returns the list of declared entry files that are missing from `dir`.
 * An absent or unparseable package.json is reported as a missing manifest so
 * the caller can distinguish "never installed" from "installed, not built".
 */
export function missingArtifacts(dir = PKG_WEB_DIR) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return ["package.json"];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return ["package.json"];
  }

  // Check exactly what a bundler resolves: the entry points the manifest
  // declares, plus the wasm binary they load at runtime.
  const declared = [manifest.main, manifest.types].filter(
    (v) => typeof v === "string" && v.length > 0,
  );
  const required = [...new Set([...declared, "pt_wasm_bg.wasm"])];
  return required.filter((f) => !existsSync(join(dir, f)));
}

export function formatFailure(missing, dir = PKG_WEB_DIR) {
  return [
    `error: @pt/wasm is not built — ${dir} is missing: ${missing.join(", ")}`,
    "",
    "  crates/pt-wasm/pkg-web is a workspace member whose entry files are",
    "  wasm-pack output, not committed sources. pnpm install links the package",
    "  but cannot produce them, so the frontend build fails to resolve @pt/wasm.",
    "",
    "  Build it once (needs wasm-pack and the wasm32-unknown-unknown target):",
    "",
    `    ${BUILD_COMMAND}`,
    "",
    "  CI does this via .github/actions/setup-pt-wasm-pkg-web before install.",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = missingArtifacts();
  if (missing.length > 0) {
    console.error(formatFailure(missing));
    process.exit(1);
  }
}
