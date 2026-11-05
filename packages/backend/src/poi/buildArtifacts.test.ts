import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReleases, CITY_SPECS, type BuilderConfig } from "./buildArtifacts.js";
import type { SourceSnapshot } from "./sourceSnapshot.js";

function snapshot(url: string): SourceSnapshot {
  return { url, path: "/fixture/source.pbf", sha256: "0".repeat(64), bytes: 1, snapshotAt: "2026-10-29T00:00:00Z", checkedAt: "2026-10-30T00:00:00Z", downloadedAt: "2026-10-30T00:00:00Z" };
}

describe("independent artifact orchestration", () => {
  it("reuses regional snapshots, bounds city concurrency and isolates city failures", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ptn-builder-"));
    try {
      const config: BuilderConfig = { cities: ["first", "second", "third", "first"], workDir, repository: "unused", signingKey: "unused", trustedKeys: ["fixture"], revision: "fixture" };
      const fetched: string[] = []; const built: string[] = []; const received: SourceSnapshot[] = [];
      let active = 0;
      const result = await buildReleases(config, {
        registry: { first: CITY_SPECS.vilnius, second: CITY_SPECS.vilnius, third: CITY_SPECS.tbilisi },
        snapshot: async (url) => { fetched.push(url); return snapshot(url); },
        buildCity: async (city, source) => {
          expect(active++).toBe(0); built.push(city); received.push(source);
          await new Promise((resolve) => setTimeout(resolve, 1)); active--;
          if (city === "second") throw new Error("resource limit");
          return `release-${city}`;
        },
      });
      expect(fetched).toHaveLength(2);
      expect(built).toEqual(["first", "second", "third"]);
      expect(received[0]).toBe(received[1]);
      expect(result).toEqual({ first: { release: "release-first" }, second: { error: "resource limit" }, third: { release: "release-third" } });
    } finally { await rm(workDir, { recursive: true, force: true }); }
  });

  it("a failed regional refresh leaves unrelated cities progressing", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ptn-builder-"));
    try {
      const fetched: string[] = []; const built: string[] = [];
      const result = await buildReleases({ cities: ["vilnius", "tbilisi"], workDir, repository: "unused", signingKey: "unused", trustedKeys: ["fixture"], revision: "fixture" }, {
        snapshot: async (url) => { fetched.push(url); if (url === CITY_SPECS.vilnius.pbf) throw new Error("upstream unavailable"); return snapshot(url); },
        buildCity: async (city) => { built.push(city); return "new-release"; },
      });
      expect(fetched).toHaveLength(2); expect(built).toEqual(["tbilisi"]);
      expect(result.vilnius.error).toBe("upstream unavailable");
      expect(result.tbilisi.release).toBe("new-release");
    } finally { await rm(workDir, { recursive: true, force: true }); }
  });
});
