import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./smokeManifest.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const dirs: string[] = [];

function runSmoke(dir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, dir], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });
}

function inactiveRecord(cityId: string, bytes: Buffer) {
  return {
    cityId,
    filename: `${cityId}.br`,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    poiTile: {
      edgeKm: 12,
      anchor: { minLat: 54.58, minLon: 25.08, refLat: 54.68 },
      tilingPolicy: "k-anon-floor",
      kAnonWaived: false,
      tileBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      deliveryActive: false,
    },
  };
}

function writeActiveKAnonCorpus(dir: string, count: number) {
  const entries = Array.from({ length: count }, (_, index) => ({
    id: `poi-${index}`,
    name: `POI ${index}`,
    aliases: {},
    category: "landmark",
    lat: 54.6,
    lon: 25.2,
    source: "osm",
    rankBoost: 0,
    tier: "strict",
  }));
  const bytes = brotliCompressSync(
    Buffer.from(
      JSON.stringify({
        meta: {
          cityId: "vilnius",
          tier: "strict",
          entryCount: count,
        },
        entries,
      }),
    ),
  );
  writeFileSync(join(dir, "vilnius.br"), bytes);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          cityId: "vilnius",
          filename: "vilnius.br",
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          poiTile: {
            edgeKm: 12,
            anchor: { minLat: 54.58, minLon: 25.08, refLat: 54.68 },
            tilingPolicy: "k-anon-floor",
            kAnonWaived: false,
            tileBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
            deliveryActive: true,
          },
        },
      ],
    }),
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("POI release manifest smoke validation", () => {
  it("caps all strict cities, including inactive records", () => {
    const dir = mkdtempSync(join(tmpdir(), "poi-smoke-city-cap-"));
    dirs.push(dir);
    const bundles = Array.from({ length: 6 }, (_, index) => {
      const cityId = `city${index}`;
      const bytes = Buffer.from([index]);
      writeFileSync(join(dir, `${cityId}.br`), bytes);
      return inactiveRecord(cityId, bytes);
    });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundles }),
    );

    const result = runSmoke(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("more than 5 strict POI cities");
  });

  it("rejects a malformed inactive strict record before release", () => {
    const dir = mkdtempSync(join(tmpdir(), "poi-smoke-inactive-invalid-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            ...inactiveRecord("vilnius", Buffer.alloc(0)),
            sizeBytes: 0,
          },
        ],
      }),
    );

    const result = runSmoke(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid manifest record for vilnius");
  });

  it("rejects exactly 49 entries in an occupied k-anon tile", () => {
    const dir = mkdtempSync(join(tmpdir(), "poi-smoke-floor-49-"));
    dirs.push(dir);
    writeActiveKAnonCorpus(dir, 49);

    const result = runSmoke(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("below k=50");
  });

  it("accepts exactly 50 entries in an occupied k-anon tile", () => {
    const dir = mkdtempSync(join(tmpdir(), "poi-smoke-floor-50-"));
    dirs.push(dir);
    writeActiveKAnonCorpus(dir, 50);

    const result = runSmoke(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("activeStrict=1");
  });
});
