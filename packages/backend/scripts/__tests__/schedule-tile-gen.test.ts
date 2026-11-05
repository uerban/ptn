import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The producer script (`schedule-tile-gen.mjs`, run via execFileSync below) is a
// SHIPPED prod artifact: it imports the backend from `../dist`. turbo's `test`
// task only builds DEPENDENCY packages (`dependsOn: ["^build"]`), NOT the
// backend's own dist, so a fresh checkout / CI has no `packages/backend/dist` —
// `vitest.globalSetup.ts` builds it ONCE before the fork pool spawns (off the
// parallel workers, so the ~13s tsc can't flake CPU-bound perf tests). This test
// loads the reference `loadFromPtb`/`buildBundle` from that SAME dist via a runtime
// `file://` import — reference and script share the exact compiled code, so the
// only thing under test is the script's plumbing (no src-vs-dist / stale-dist
// skew). Types are pulled type-only from src (erased — no runtime dist need).
type LoadFromPtb = typeof import("../../src/gtfs/loadFromPtb.js").loadFromPtb;
type BuildBundle = typeof import("../../src/gtfs/buildBundle.js").buildBundle;
let loadFromPtb: LoadFromPtb;
let buildBundle: BuildBundle;

// Byte-parity gate for the producer-side schedule-tile build.
//
// The script `schedule-tile-gen.mjs` reconstructs a CanonicalStore from a
// staged PTB (`loadFromPtb`) and runs the EXISTING `buildBundle` to write the
// tile bundle into a generation dir. This test pins that the producer-built
// `.br` tiles are byte-identical to what an in-process `buildBundle` produces
// over the SAME canonical inputs. Both sides load the same `bundle.ptb` via
// `loadFromPtb` and build the same resolvers from the same `route-styles.json`,
// so the only thing under test is the script's plumbing — any divergence is a
// reconstruction bug in the script, not an input difference.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "schedule-tile-gen.mjs");
const FIXTURES = join(HERE, "..", "..", "src", "gtfs", "__fixtures__");

// generationId doubles as the bundleHash on both sides — pick a stable value.
const GENERATION_ID = "scheduletilegenfixturehash01";

// route-styles.json the script reads to build the route resolvers. Mix an
// explicit override (R1 → #112233) with an omitted route (R2 falls back to its
// GTFS route_color) so both resolver branches are exercised.
const ROUTE_STYLES = {
  R1: { color: "112233", textColor: "FFFFFF", subMode: "BUS" },
} as const;

/**
 * Recursively collect every `.br` tile under `dir`, keyed by its path relative
 * to `dir` (so the two bundles can be compared file-for-file regardless of the
 * absolute staging/data root).
 */
function collectTiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (cur: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".br")) out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** Resolvers identical to the ones the script builds from route-styles.json. */
function resolversFromStyles(styles: Record<string, { color: string; subMode: string }>) {
  return {
    resolveRouteColor: (rid: string): string | undefined => {
      const c = styles[rid]?.color;
      return c ? `#${c}` : undefined;
    },
    resolveRouteSubMode: (rid: string): string | undefined => styles[rid]?.subMode,
  };
}

describe("schedule-tile-gen.mjs byte parity", () => {
  let staging: string;
  let refDataDir: string;
  let referenceTiles: Map<string, Buffer>;
  let referenceBundleHash: string;

  beforeAll(async () => {
    // ── Load the reference build fns from the dist that globalSetup guaranteed
    //    (the SAME compiled code the producer script imports). ──
    const backendDir = join(HERE, "..", "..");
    const distFn = (m: string) => pathToFileURL(join(backendDir, "dist", "gtfs", m)).href;
    ({ loadFromPtb } = await import(distFn("loadFromPtb.js")));
    ({ buildBundle } = await import(distFn("buildBundle.js")));

    // ── Staging dir the script consumes: bundle.ptb + sidecars + route-styles +
    //    generation.json (mirrors a producer generation dir). ──
    staging = mkdtempSync(join(tmpdir(), "ptn-stgen-staging-"));
    copyFileSync(join(FIXTURES, "bundle.ptb"), join(staging, "bundle.ptb"));
    copyFileSync(join(FIXTURES, "bundle.ptb.meta.json"), join(staging, "bundle.ptb.meta.json"));
    copyFileSync(join(FIXTURES, "bundle.ptb.shapes.json"), join(staging, "bundle.ptb.shapes.json"));
    writeFileSync(join(staging, "route-styles.json"), JSON.stringify(ROUTE_STYLES));
    writeFileSync(join(staging, "generation.json"), JSON.stringify({ generationId: GENERATION_ID }));

    // ── Reference: in-process buildBundle over the SAME loadFromPtb canonical
    //    and the SAME resolvers the script derives from route-styles.json. ──
    refDataDir = mkdtempSync(join(tmpdir(), "ptn-stgen-ref-"));
    const loaded = await loadFromPtb(join(staging, "bundle.ptb"), 0);
    referenceBundleHash = GENERATION_ID;
    // must match PT_CITY_ID injected to the script via execFileSync below; any non-empty slug works
    await buildBundle({
      canonical: loaded.canonical,
      bundleHash: referenceBundleHash,
      cityId: "vilnius",
      dataDir: refDataDir,
      ...resolversFromStyles(ROUTE_STYLES),
    });
    referenceTiles = collectTiles(join(refDataDir, referenceBundleHash));
  }, 30_000); // margin for the reference loadFromPtb + brotli build (dist is prebuilt by globalSetup)

  afterAll(() => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(refDataDir, { recursive: true, force: true });
  });

  it("produces a non-empty reference bundle (fixture sanity)", () => {
    expect(referenceTiles.size).toBeGreaterThan(0);
  });

  it("every producer-built .br tile is byte-identical to the reference build", () => {
    // Run the producer script over the staging dir.
    // cityId labels the tile bytes; the reference built with "vilnius", so the
    // script must see the same via its env-derived cityId path.
    const stdout = execFileSync("node", [SCRIPT, staging], {
      cwd: join(HERE, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, PT_CITY_ID: "vilnius" },
    });
    // The script prints "schedule-tile-bundle <sha256> <bytes> <bundleHash>".
    expect(stdout).toMatch(/schedule-tile-bundle [0-9a-f]{64} \d+ \S+/);

    const producedRoot = join(staging, "schedule-tiles", GENERATION_ID);
    expect(statSync(producedRoot).isDirectory()).toBe(true);
    const producedTiles = collectTiles(producedRoot);

    // Same set of tile paths, and every tile byte-identical.
    expect([...producedTiles.keys()].sort()).toEqual([...referenceTiles.keys()].sort());
    expect(producedTiles.size).toBeGreaterThan(0);
    for (const [rel, refBytes] of referenceTiles) {
      const got = producedTiles.get(rel);
      expect(got, `missing producer tile ${rel}`).toBeDefined();
      expect(
        Buffer.compare(got!, refBytes),
        `tile ${rel} differs (producer ${got!.byteLength}B vs reference ${refBytes.byteLength}B)`,
      ).toBe(0);
    }
  });

  it("writes a manifest.json at the bundle root advertising the generationId hash", () => {
    const manifest = JSON.parse(
      readFileSync(join(staging, "schedule-tiles", "manifest.json"), "utf8"),
    );
    expect(manifest.bundleHash).toBe(GENERATION_ID);
    expect(manifest.tileSize).toBeGreaterThan(0);
  });

  it("emits trip-route.json (interned) and stop-cell.json with parseable SHA lines", async () => {
    const stdout = execFileSync("node", [SCRIPT, staging], {
      cwd: join(HERE, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, PT_CITY_ID: "vilnius" },
    });

    // ── trip-route.json: interned { routes: string[], trips: {tripId: routeIdx} }
    const tripRoute = JSON.parse(readFileSync(join(staging, "trip-route.json"), "utf8"));
    expect(Array.isArray(tripRoute.routes)).toBe(true);
    expect(typeof tripRoute.trips).toBe("object");
    const tripEntries = Object.entries(tripRoute.trips) as Array<[string, number]>;
    expect(tripEntries.length).toBeGreaterThan(0);
    // every trip resolves to a real route string via the interned routes[] array
    for (const [, idx] of tripEntries) {
      expect(typeof tripRoute.routes[idx]).toBe("string");
    }
    // bare tripId keys only (no date-scoped `tripId|YYYYMMDD` RT keys)
    expect(tripEntries.every(([tripId]) => !tripId.includes("|"))).toBe(true);

    // ── stop-cell.json: { stopId: tileCoords } straight from buildBundle's return
    const stopCell = JSON.parse(readFileSync(join(staging, "stop-cell.json"), "utf8"));
    expect(Object.values(stopCell).every((v) => typeof v === "string")).toBe(true);
    // every mapped tileCoords equals an on-disk .br tile the build wrote. The
    // tileCoords value is the bare cell key (`x_y[-suffix]`); the .br lives under
    // a tile-size band subdir (e.g. `6km/271_1014.br`), so compare on basename.
    const writtenCoords = new Set(
      [...collectTiles(join(staging, "schedule-tiles", GENERATION_ID)).keys()].map((rel) =>
        rel.replace(/^.*\//, "").replace(/\.br$/, ""),
      ),
    );
    for (const coords of Object.values(stopCell) as string[]) {
      expect(writtenCoords.has(coords)).toBe(true);
    }

    // ── SHA lines printed (the `<name> <sha256> <bytes>` protocol the producer parses)
    expect(stdout).toMatch(/^trip-route [0-9a-f]{64} \d+$/m);
    expect(stdout).toMatch(/^stop-cell [0-9a-f]{64} \d+$/m);
  });
});
