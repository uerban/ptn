#!/usr/bin/env node
// Build the arrive-by WASM package, crates/pt-wasm/pkg-web-arrive-by.
//
// The frontend build reads this package unless `PTN_ARRIVE_BY_EXPERIMENT=0`;
// without it (and without the flag) the frontend builds with arrive-by off.
//
// The profile is `speed-lto`, the one the user selected for the deadline chunk:
// a
// cdylib-only cargo build at opt-level 3 with LTO, one codegen unit and
// panic=abort, then wasm-bindgen (web) and Binaryen -O3. wasm-pack is not used
// because its release profile runs Binaryen at -O. The setup-profile feature
// stays off, so the package has no `takeSetupProfile` export.
//
// The output names are `pt_arrive_by*`, not `pt_wasm*`: the default
// `pt-wasm chunk (lazy)` size budget globs `pt_wasm*`, and this package must
// not be counted against it, or hide inside it.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_NAME = "pt_arrive_by";
export const FEATURE = "temporal-deadline";
export const DEFAULT_OUT_DIR = join(ROOT, "crates", "pt-wasm", "pkg-web-arrive-by");
export const DEFAULT_TARGET_DIR = join(ROOT, "target", "pt-wasm-arrive-by");
const RECEIPT = "build.json";

/** Cargo profile overrides for `speed-lto`, scoped to this one build. */
export const PROFILE_ENV = Object.freeze({
  CARGO_PROFILE_RELEASE_PANIC: "abort",
  CARGO_PROFILE_RELEASE_OPT_LEVEL: "3",
  CARGO_PROFILE_RELEASE_LTO: "true",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
  CARGO_PROFILE_RELEASE_STRIP: "true",
});

export const OPTIMIZER_ARGS = Object.freeze(["-O3", "--enable-bulk-memory", "--enable-nontrapping-float-to-int"]);

export function cargoArgs(feature = FEATURE) {
  return ["rustc", "-p", "pt-wasm", "--lib", "--release", "--target", "wasm32-unknown-unknown",
    "--crate-type", "cdylib", "--locked", "--features", feature];
}

/** The version Cargo.lock pins for `name`, or null. */
export function lockVersion(lockText, name) {
  const blocks = lockText.split(/\n(?=\[\[package\]\])/);
  for (const block of blocks) {
    const n = block.match(/^name = "([^"]+)"$/m)?.[1];
    if (n === name) return block.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
  }
  return null;
}

/** `wasm-bindgen 0.2.122` → `0.2.122`. */
export function cliVersion(output) {
  return output.trim().match(/^wasm-bindgen (\S+)$/)?.[1] ?? null;
}

/**
 * Where to find Binaryen's wasm-opt: `$WASM_OPT`, then PATH, then the copy
 * wasm-pack downloads into its cache. Returns null when none exists.
 */
export function findWasmOpt({ env = process.env, exists = existsSync, list = safeList, home = homedir(),
  platform = process.platform, onPath = whichSync } = {}) {
  if (env.WASM_OPT) return exists(env.WASM_OPT) ? env.WASM_OPT : null;
  const fromPath = onPath("wasm-opt");
  if (fromPath) return fromPath;
  const cache = platform === "darwin" ? join(home, "Library", "Caches", ".wasm-pack") : join(home, ".cache", ".wasm-pack");
  const found = list(cache).filter((d) => d.startsWith("wasm-opt-")).sort()
    .map((d) => join(cache, d, "bin", "wasm-opt")).filter((p) => exists(p));
  return found.length ? found[found.length - 1] : null;
}

function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function whichSync(cmd) {
  const r = spawnSync("command", ["-v", cmd], { shell: true, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The glue must expose the deadline probe and its H58/H81 scans, and nothing
 * from the setup-profile build. Returns the list of problems. */
export function glueProblems(glue) {
  const problems = [];
  if (!/export class TemporalDeadlineProbe\b/.test(glue)) problems.push("no TemporalDeadlineProbe export");
  if (!/\blatestDeparture\(/.test(glue)) problems.push("no latestDeparture method");
  if (!/\bselectorDeparture\(/.test(glue)) problems.push("no selectorDeparture method");
  if (!/\brun_winner_journeys\(/.test(glue)) problems.push("no run_winner_journeys method");
  if (/takeSetupProfile/.test(glue)) problems.push("setup-profile export present");
  if (!glue.includes(`${OUT_NAME}_bg.wasm`)) problems.push(`glue does not load ${OUT_NAME}_bg.wasm`);
  return problems;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status ?? r.signal}`);
}

function main() {
  const { values } = parseArgs({ options: { "out-dir": { type: "string" }, "target-dir": { type: "string" } } });
  const outDir = resolve(values["out-dir"] ?? DEFAULT_OUT_DIR);
  const targetDir = resolve(values["target-dir"] ?? DEFAULT_TARGET_DIR);
  // Never replace a directory this script did not write.
  if (existsSync(outDir) && !existsSync(join(outDir, RECEIPT))) {
    throw new Error(`${outDir} exists without ${RECEIPT}; refusing to replace it`);
  }

  const lock = readFileSync(join(ROOT, "Cargo.lock"), "utf8");
  const wantBindgen = lockVersion(lock, "wasm-bindgen");
  const haveBindgen = cliVersion(execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }));
  if (!wantBindgen || haveBindgen !== wantBindgen) {
    throw new Error(`wasm-bindgen CLI ${haveBindgen} does not match the crate ${wantBindgen} in Cargo.lock`);
  }
  const wasmOpt = findWasmOpt();
  if (!wasmOpt) throw new Error("wasm-opt not found: set WASM_OPT, put it on PATH, or run a wasm-pack build once");

  run("cargo", cargoArgs(), { ...PROFILE_ENV, CARGO_TARGET_DIR: targetDir });
  const raw = join(targetDir, "wasm32-unknown-unknown", "release", "pt_wasm.wasm");
  const bindgenDir = join(targetDir, "bindgen-web");
  rmSync(bindgenDir, { recursive: true, force: true });
  run("wasm-bindgen", [raw, "--out-dir", bindgenDir, "--out-name", OUT_NAME, "--typescript", "--target", "web"]);

  const staging = `${outDir}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const name of readdirSync(bindgenDir)) {
    if (name !== `${OUT_NAME}_bg.wasm`) writeFileSync(join(staging, name), readFileSync(join(bindgenDir, name)));
  }
  run(wasmOpt, [join(bindgenDir, `${OUT_NAME}_bg.wasm`), ...OPTIMIZER_ARGS, "-o", join(staging, `${OUT_NAME}_bg.wasm`)]);

  const glue = readFileSync(join(staging, `${OUT_NAME}.js`), "utf8");
  const problems = glueProblems(glue);
  const wasm = readFileSync(join(staging, `${OUT_NAME}_bg.wasm`));
  new WebAssembly.Module(wasm); // Rejects a malformed optimizer output.
  if (problems.length) throw new Error(`arrive-by package check failed: ${problems.join("; ")}`);

  const head = process.env.GIT_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  // Image builds provide GIT_SHA without Git metadata; dirtiness is unknown there.
  // Locally, only compiler inputs count: an edited .gitignore is not a dirty build.
  const dirty = process.env.GIT_SHA ? null : execFileSync("git", ["status", "--porcelain", "--", ":(glob)crates/**/*.rs",
    ":(glob)crates/**/Cargo.toml", "Cargo.lock", "Cargo.toml", "rust-toolchain.toml"],
  { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  const receipt = {
    schema: 1, package: OUT_NAME, feature: FEATURE, profile: "speed-lto", head, sourceDirty: dirty,
    cargo: ["cargo", ...cargoArgs()], env: PROFILE_ENV, wasmBindgen: haveBindgen, optimizer: [...OPTIMIZER_ARGS],
    rawWasm: { sha256: sha256(readFileSync(raw)), bytes: readFileSync(raw).length },
    wasm: { file: `${OUT_NAME}_bg.wasm`, sha256: sha256(wasm), bytes: wasm.length, gzipBytes: gzipSync(wasm, { level: 9 }).length },
    glue: { file: `${OUT_NAME}.js`, sha256: sha256(glue) },
  };
  writeFileSync(join(staging, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
  rmSync(outDir, { recursive: true, force: true });
  renameSync(staging, outDir);
  console.log(JSON.stringify({ outDir, wasm: receipt.wasm, head, sourceDirty: dirty }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
