import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// `privacy.*` strings live in a lazily fetched namespace. A component that
// shows one through the base `t()` without requesting the namespace renders
// its inline English fallback in every locale.
const SRC = join(__dirname, "..");

// Files whose privacy strings are only handed to a component that requests
// the namespace itself (the provider re-renders them once it lands).
const RELIES_ON_CHILD = new Set([
  "pages/Search.tsx", // title/description for OptionalStorageChoice
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("privacy namespace", () => {
  it("is requested by every component that shows privacy.* keys", () => {
    const missing = sources(SRC)
      .filter((path) => /\bt\(\s*["`]privacy\./.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .filter((rel) => !RELIES_ON_CHILD.has(rel))
      .filter((rel) => !readFileSync(join(SRC, rel), "utf8").includes("usePrivacyNamespace("));
    expect(missing).toEqual([]);
  });
});
