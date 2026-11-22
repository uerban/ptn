import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeAppVersion, tryGit } from "./app-version.mjs";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PT_VERSION: "",
  PT_VERSION_MAIN_REF: "",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

function setVersion(dir, version) {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
}

// Lands a one-commit branch on main as a --no-ff merge and returns the merge SHA.
function merge(dir, name, change) {
  git(dir, "checkout", "-q", "-b", name, "main");
  change();
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", name);
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
  return git(dir, "rev-parse", "HEAD");
}

function version(cwd, extra = {}) {
  return computeAppVersion({ cwd, env: { ...ENV, PT_VERSION_MAIN_REF: "main", ...extra } });
}

const short = (dir, rev) => git(dir, "rev-parse", "--short=8", rev);

describe("computeAppVersion on a fixture repository", () => {
  let dir;
  const commits = {};

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "app-version-"));
    git(dir, "init", "-q", "-b", "main");
    setVersion(dir, "0.1.0");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    commits.init = git(dir, "rev-parse", "HEAD");
    commits.a = merge(dir, "a", () => writeFileSync(join(dir, "a.txt"), "a"));
    commits.b = merge(dir, "b", () => writeFileSync(join(dir, "b.txt"), "b"));
    commits.minor = merge(dir, "minor", () => setVersion(dir, "0.2.0"));
    commits.c = merge(dir, "c", () => writeFileSync(join(dir, "c.txt"), "c"));
    // A legacy patch bump must not move the anchor.
    commits.patch = merge(dir, "patch", () => setVersion(dir, "0.2.7"));
    commits.d = merge(dir, "d", () => writeFileSync(join(dir, "d.txt"), "d"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("counts first-parent commits since the merge that introduced major.minor", () => {
    const at = rev => computeAppVersion({ cwd: dir, rev, env: { ...ENV, PT_VERSION_MAIN_REF: "main" } });
    assert.equal(at(commits.init), "0.1.0");
    assert.equal(at(commits.a), "0.1.1");
    assert.equal(at(commits.b), "0.1.2");
    assert.equal(at(commits.minor), "0.2.0");
    assert.equal(at(commits.c), "0.2.1");
    assert.equal(at(commits.patch), "0.2.2");
    assert.equal(version(dir), "0.2.3");
  });

  test("feature branch builds are -dev with the merge-base number and SHA", () => {
    git(dir, "checkout", "-q", "-b", "feature", commits.c);
    writeFileSync(join(dir, "f.txt"), "f");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feature");
    try {
      assert.equal(version(dir), `0.2.1-dev+${short(dir, "HEAD")}`);
    } finally {
      git(dir, "checkout", "-q", "main");
    }
  });

  test("a branch raising major.minor is X.(Y+1).0-dev until merged", () => {
    git(dir, "checkout", "-q", "-b", "next-minor", "main");
    setVersion(dir, "0.3.0");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "bump");
    try {
      assert.equal(version(dir), `0.3.0-dev+${short(dir, "HEAD")}`);
    } finally {
      git(dir, "checkout", "-q", "main");
    }
  });

  test("a second-parent commit of a merge is not a main version", () => {
    const branchTip = git(dir, "rev-parse", `${commits.d}^2`);
    const got = computeAppVersion({ cwd: dir, rev: branchTip, env: { ...ENV, PT_VERSION_MAIN_REF: "main" } });
    assert.equal(got, `0.2.2-dev+${short(dir, branchTip)}`);
  });

  test("without a resolvable main ref the build is X.Y.0-dev with SHA", () => {
    assert.equal(version(dir, { PT_VERSION_MAIN_REF: "no-such-ref" }), `0.2.0-dev+${short(dir, "HEAD")}`);
  });

  test("a single refs/remotes/*/main is used when origin/main is absent", () => {
    git(dir, "update-ref", "refs/remotes/upstream/main", "main");
    try {
      assert.equal(computeAppVersion({ cwd: dir, env: ENV }), "0.2.3");
    } finally {
      git(dir, "update-ref", "-d", "refs/remotes/upstream/main");
    }
  });

  test("a shallow clone falls back to X.Y.0-dev", () => {
    const clone = mkdtempSync(join(tmpdir(), "app-version-shallow-"));
    try {
      git(clone, "clone", "-q", "--depth", "1", `file://${dir}`, ".");
      assert.equal(version(clone), "0.2.0-dev");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("PT_VERSION wins when valid and is ignored when malformed", () => {
    assert.equal(version(dir, { PT_VERSION: "1.4.12" }), "1.4.12");
    assert.equal(version(dir, { PT_VERSION: "1.4.0-dev+abcdef12" }), "1.4.0-dev+abcdef12");
    assert.equal(version(dir, { PT_VERSION: "v1.4.12" }), "0.2.3");
    assert.equal(version(dir, { PT_VERSION: "refs/heads/main" }), "0.2.3");
  });

  test("inherited git discovery variables do not redirect the repository", () => {
    const other = mkdtempSync(join(tmpdir(), "app-version-other-"));
    try {
      git(other, "init", "-q", "-b", "main");
      assert.equal(version(dir, { GIT_DIR: join(other, ".git") }), "0.2.3");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

test("without git the version comes from package.json as X.Y.0-dev", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-version-nogit-"));
  try {
    setVersion(dir, "3.4.5");
    assert.equal(computeAppVersion({ cwd: dir, env: ENV }), "3.4.0-dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real history: v0.2.2 is 0.2.29", { skip: realHistorySkip() }, () => {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  assert.equal(computeAppVersion({ cwd: root, rev: "v0.2.2", env: { ...process.env, PT_VERSION: "" } }), "0.2.29");
});

function realHistorySkip() {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  if (tryGit(root, ["rev-parse", "--is-shallow-repository"]) !== "false") return "needs a full clone";
  if (!tryGit(root, ["rev-parse", "--verify", "--quiet", "v0.2.2^{commit}"])) return "needs tag v0.2.2";
  return false;
}
