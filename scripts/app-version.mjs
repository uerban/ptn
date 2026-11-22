// Application version producer: the single source of the displayed version.
//
// The version is derived, never bumped by hand past major.minor:
//
//   X.Y.N            a commit on main's first-parent history; N counts main
//                    commits since the merge that introduced X.Y
//   X.Y.N-dev+<sha>  any other commit; N is that of its merge-base with main
//   X.Y.0-dev+<sha>  a branch that raises major.minor (not on main yet), or no
//                    main ref to compare against
//   X.Y.0-dev        no usable history (no git, shallow clone)
//
// X.Y comes from the root package.json; its patch digit is ignored. Every
// first-parent commit on main counts, so numbers between releases have gaps
// by design. The same commit always yields the same version, as long as the
// clone has full history and a main ref.
//
// Precedence: PT_VERSION env (CI computes once and injects it) > git > fallback.
// The main ref is PT_VERSION_MAIN_REF, else origin/main, else the only
// refs/remotes/*/main.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// git exports its repo-discovery variables into every hook it runs, and they
// take precedence over `cwd`. Inheriting them would read whichever repository
// the hook belongs to, so they are dropped for every git call made here.
const GIT_DISCOVERY_VARS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
];

function gitEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !GIT_DISCOVERY_VARS.includes(key)),
  );
}

export function tryGit(cwd, args, env = process.env) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(env),
    }).trim();
  } catch {
    return null;
  }
}

const INJECTED = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev(\+[0-9a-f]{7,40})?)?$/;

function majorMinor(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\./.exec(String(version ?? ""));
  return match ? `${match[1]}.${match[2]}` : null;
}

function majorMinorAt(cwd, rev, env) {
  const raw = tryGit(cwd, ["show", `${rev}:package.json`], env);
  if (raw === null) return null;
  try {
    return majorMinor(JSON.parse(raw).version);
  } catch {
    return null;
  }
}

function resolveMainRef(cwd, env) {
  const candidates = [];
  if (env.PT_VERSION_MAIN_REF) candidates.push(env.PT_VERSION_MAIN_REF);
  candidates.push("origin/main");
  for (const ref of candidates) {
    const sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], env);
    if (sha) return sha;
  }
  const remotes = (tryGit(cwd, ["for-each-ref", "--format=%(objectname)", "refs/remotes/*/main"], env) ?? "")
    .split("\n")
    .filter(Boolean);
  return new Set(remotes).size === 1 ? remotes[0] : null;
}

// Number of first-parent commits since the merge that introduced `rev`'s
// major.minor, or null when it cannot be determined.
function patchAt(cwd, rev, xy, env) {
  const touching = tryGit(cwd, ["log", "--first-parent", "--format=%H", rev, "--", ":/package.json"], env);
  if (!touching) return null;
  let anchor = null;
  for (const commit of touching.split("\n")) {
    if (majorMinorAt(cwd, commit, env) !== xy) break;
    anchor = commit;
  }
  if (anchor === null) return null;
  const count = tryGit(cwd, ["rev-list", "--count", "--first-parent", `${anchor}..${rev}`], env);
  return count !== null && /^[0-9]+$/.test(count) ? Number(count) : null;
}

/**
 * Computes the application version.
 * @param {object} options
 * @param {string} options.cwd directory inside the repository (or the package dir)
 * @param {string} [options.packageJson] package.json used for major.minor when git is unusable
 * @param {string} [options.rev] revision to describe (default HEAD)
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function computeAppVersion({ cwd, packageJson, rev = "HEAD", env = process.env }) {
  const injected = (env.PT_VERSION ?? "").trim();
  if (injected) {
    if (INJECTED.test(injected)) return injected;
    process.stderr.write(
      `[app-version] PT_VERSION="${injected}" is not X.Y.N or X.Y.N-dev[+sha]; ignoring it\n`,
    );
  }

  let fallbackXY = null;
  try {
    fallbackXY = majorMinor(JSON.parse(readFileSync(packageJson ?? resolve(cwd, "package.json"), "utf8")).version);
  } catch {
    /* handled below */
  }

  const sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], env);
  const shallow = tryGit(cwd, ["rev-parse", "--is-shallow-repository"], env) === "true";
  const xy = (sha && majorMinorAt(cwd, sha, env)) ?? fallbackXY ?? "0.0";
  if (!sha || shallow) return `${xy}.0-dev`;

  const short = tryGit(cwd, ["rev-parse", "--short=8", sha], env) ?? sha.slice(0, 8);
  const main = resolveMainRef(cwd, env);
  if (!main) return `${xy}.0-dev+${short}`;

  const mainline = new Set((tryGit(cwd, ["rev-list", "--first-parent", main], env) ?? "").split("\n"));
  if (mainline.has(sha)) {
    const n = patchAt(cwd, sha, xy, env);
    return n === null ? `${xy}.0-dev+${short}` : `${xy}.${n}`;
  }

  // Newest main commit this one builds on (also right for a commit that was
  // merged as a second parent, where merge-base would return the commit itself).
  const base = (tryGit(cwd, ["rev-list", "--topo-order", sha], env) ?? "")
    .split("\n")
    .find(commit => mainline.has(commit));
  if (base && majorMinorAt(cwd, base, env) === xy) {
    const n = patchAt(cwd, base, xy, env);
    if (n !== null) return `${xy}.${n}-dev+${short}`;
  }
  return `${xy}.0-dev+${short}`;
}

// CLI: node scripts/app-version.mjs [rev]
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  process.stdout.write(`${computeAppVersion({ cwd: root, rev: process.argv[2] ?? "HEAD" })}\n`);
}
