import { type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// Relative into `@pt/shared`'s SOURCE, not the `@pt/shared` package entry:
// that entry resolves to `dist/`, which only exists after the package has
// been built. The self-deploy smoke job (`Clean Clone Deploy`) installs from
// a clean clone and runs `e2e:validate` against the deployed containers
// without ever building the workspace on the host, so a package-entry import
// here fails every core spec at module load. Matches `catalogPtb.ts`.
import { PATTERN_MODE } from "../../../shared/src/raptor/patternMode.ts";
import { buildCatalogPtb } from "../fixtures/catalogPtb.ts";
import { seedCompletedSetup } from "./setup-complete.ts";
import {
  FIXTURE_BUNDLE_HASH,
  buildFixtureManifest,
  buildFixtureRtTile,
  buildFixtureTileBytes,
} from "./schedule-tile-fixture.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const stopsNearby = JSON.parse(readFileSync(join(fixturesDir, "stops-nearby.json"), "utf-8"));
const stopsAll = JSON.parse(readFileSync(join(fixturesDir, "stops-all.json"), "utf-8"));
const departuresFixture = JSON.parse(readFileSync(join(fixturesDir, "departures.json"), "utf-8"));
const colorConfig = JSON.parse(readFileSync(join(fixturesDir, "color-config.json"), "utf-8"));
const shapesFixture = JSON.parse(readFileSync(join(fixturesDir, "shapes.json"), "utf-8"));

// PTB v2 copy of the producer's `tests/fixtures/tiny-gtfs.zip` feed (the same
// routing data as the v1 `crates/pt-core/tests/fixtures/producer-current.ptb`,
// which stays frozen for the v1 goldens). The browser plans only on v2, so the
// mock serves this file for `/api/<city>/raptor-bundle` (the bytes
// pt-wasm's `PtRouter::new()` decodes on the frontend), used by the S1→S3
// parity/cold-start cases. Regenerate with
// `PTN_REGEN_E2E_V2=1 cargo test -p pt-producer --test e2e_v2_fixture`.
// Mirrors the backend route's content-derived ETag
// (sha256(bytes).slice(0,32)). Playwright's route.fulfill rejects 304
// responses, so the mock legally ignores a matching `If-None-Match` and
// returns 200 with the same bytes. The production 304 path is covered in
// gtfsBundleBytes.test.ts.
const PTB_BYTES: Buffer = readFileSync(join(fixturesDir, "tiny-v2.ptb"));
if (
  PTB_BYTES.length < 6 ||
  PTB_BYTES.toString("latin1", 0, 4) !== "PTB\0" ||
  PTB_BYTES.readUInt16LE(4) !== 2
) {
  throw new Error(
    "tiny-v2.ptb is not a PTB v2 fixture (expected magic \"PTB\\0\" and version 2). " +
      "Regenerate it with PTN_REGEN_E2E_V2=1 cargo test -p pt-producer --test e2e_v2_fixture.",
  );
}

/**
 * Real brotli-dec-wasm binary — see the `**\/*.wasm` route below for why.
 *
 * Resolved via the package's MAIN entry rather than a subpath: brotli-dec-wasm
 * declares `exports` without a `./pkg/*` entry, so requiring the `.wasm`
 * directly throws ERR_PACKAGE_PATH_NOT_EXPORTED. The binary sits next to the
 * resolved entry.
 */
const BROTLI_WASM_BYTES: Buffer = (() => {
  const entry = createRequire(import.meta.url).resolve("brotli-dec-wasm");
  const candidates = [
    join(dirname(entry), "brotli_dec_wasm_bg.wasm"),
    join(dirname(entry), "pkg", "brotli_dec_wasm_bg.wasm"),
    join(dirname(entry), "..", "pkg", "brotli_dec_wasm_bg.wasm"),
  ];
  for (const c of candidates) {
    try {
      return readFileSync(c);
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `brotli-dec-wasm binary not found next to ${entry}. The tile read path cannot ` +
      `decompress without it under Chromium, and every schedule-tile test would ` +
      `silently fall back to the legacy route instead of failing.`,
  );
})();
/**
 * The Vilnius fixture as PTB bytes — the harness's default catalog.
 *
 * The browser has one catalog path now: PTB bytes from `/raptor-bundle`, paired
 * with the generation on `/ready`. The rich Vilnius topology the specs assert
 * on is the producer's build of `raptor-data.json`, re-anchored to the day the
 * harness runs (see `fixtures/catalogPtb.ts`).
 *
 * Keyed by anchor date because a PTB's service bitmasks only cover a fixed
 * window (400 days here) from its feed start: a spec that pins the page clock to a date outside the
 * window gets a catalog with no service at all, which surfaces as "No routes
 * found" rather than as anything pointing at the clock. Specs that pin a clock
 * pass the same instant as `catalogNow` (see `MockApiOptions`).
 */
const catalogByAnchor = new Map<string, Buffer>();

function catalogPtbFor(now: Date, shapes: "advertised" | "absent"): Buffer {
  const key = `${now.toISOString().slice(0, 10)}:${shapes}`;
  let bytes = catalogByAnchor.get(key);
  if (!bytes) {
    // "absent" is the committed build without shape_id on any trip, which is
    // what a feed with no shapes.txt produces. Paired with the null shapes
    // provenance on `/ready` below, it is the shapeless case end to end.
    bytes = Buffer.from(buildCatalogPtb({ now, shapes }));
    catalogByAnchor.set(key, bytes);
  }
  return bytes;
}

/** Raw catalog content digest, independent of the publication ID used by tiles. */
function generationIdFor(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PTB_MATCHED_GENERATION_ID = generationIdFor(PTB_BYTES);

export const PTB_MATCHED_STOP_QUERY = "fromStopId=S1&toStopId=S3";
export const PTB_MATCHED_FIXED_TIME = new Date("2026-05-05T06:50:00+03:00");

interface MockApiOptions {
  routingFixture?: "vilnius" | "ptb-matched";
  /**
   * Anchor for the Vilnius catalog's 90-day service window. Pass the SAME
   * instant a spec pins the page clock to (`page.clock.setFixedTime`), or the
   * bundle carries no service on the day the app thinks it is, and every
   * search comes back empty. Defaults to the real current date, which is
   * correct for specs that do not pin a clock.
   */
  catalogNow?: Date;
  /**
   * Whether the catalog carries shape geometry. `"absent"` drops `shape_id`
   * from every trip AND makes `/ready` advertise null shapes provenance —
   * the shapeless-feed case the route overlay must degrade through. Both
   * halves are needed: either one alone is a half-shapeless bundle no real
   * generation produces.
   */
  catalogShapes?: "advertised" | "absent";
  /**
   * Schedule-tile serving mode.
   *
   * `"served"` (default) mirrors production: the tile read path resolves and
   * the network departures route is never needed. `"unavailable"` makes every
   * tile request 503 so a spec can deliberately exercise the cascade fallback.
   *
   * Before this option existed the suite had NO tile handlers at all, so it was
   * permanently in the `"unavailable"` shape without saying so — every
   * departures assertion was validating the fallback while believing it covered
   * the primary path.
   */
  scheduleTile?: "served" | "unavailable";
  /**
   * `"complete"` (default) seeds a finished first-run setup so the spec starts
   * in the app (see `seedCompletedSetup`). `"fresh"` leaves the profile new,
   * for specs that drive setup themselves.
   */
  setup?: "complete" | "fresh";
  /**
   * `X-PT-Realtime` value on manifest responses: the realtime kinds the city
   * offers (`"departures, alerts"`). Absent sends no header, which the client
   * records as "no realtime kinds".
   */
  realtime?: string;
}

/**
 * Per-page counter of network departures hits, for `legacyDeparturesHits`.
 *
 * The route it counts moved on 2026-08-10, from Node's `/api/departures` to
 * pt-serve's `/api/<city>/departures-for-stop`. The `**\/api/**\/departures*`
 * glob below matches both, so the counter kept working across that move without
 * an edit — and the `legacy` naming is kept so specs asserting `=== 0` do not
 * churn. Read it as "did the client fall back to the network", not "did it call
 * Node".
 */
const legacyDepartureHits = new WeakMap<Page, number>();

/**
 * How many times this page hit the network departures route.
 *
 * A tile-path spec asserts this is 0. Without it a regression that silently
 * drops back to the network still renders identical departures (the legacy Node
 * route ran the same `getDeparturesFromTile`, and pt-serve's replacement returns
 * the same `Departure` shape), so the UI assertions alone cannot tell the two
 * apart — which is exactly how the original gap went unnoticed.
 */
export function legacyDeparturesHits(page: Page): number {
  return legacyDepartureHits.get(page) ?? 0;
}

// Compute the shapes body + hash once per helper import. The client verifies
// sha256(body) against the hash `/ready` advertises, so the two must be derived
// from the same bytes. (This used to be patched into a cloned raptor-data
// payload, which is where the fixture's `HASH_PLACEHOLDER` came from.)
const SHAPES_BODY = JSON.stringify(shapesFixture);
const SHAPES_HASH = createHash("sha256").update(SHAPES_BODY).digest("hex");
const SHAPES_SIZE_BYTES = Buffer.byteLength(SHAPES_BODY, "utf8");

/** Replace PLACEHOLDER timestamps with real times relative to now */
function makeDepartures(now: Date = new Date()) {
  const nowMs = now.getTime();
  const offsets: Record<string, number> = {
    PLACEHOLDER_DUE: 60_000,
    PLACEHOLDER_5MIN: 5 * 60_000,
    PLACEHOLDER_8MIN: 8 * 60_000,
    PLACEHOLDER_10MIN: 10 * 60_000,
    PLACEHOLDER_15MIN: 15 * 60_000,
    PLACEHOLDER_25MIN: 25 * 60_000,
  };

  const data = departuresFixture.data.map((dep) => ({
    ...dep,
    scheduledTime: offsets[dep.scheduledTime]
      ? new Date(nowMs + offsets[dep.scheduledTime]).toISOString()
      : dep.scheduledTime,
    predictedTime:
      dep.predictedTime && offsets[dep.predictedTime]
        ? new Date(nowMs + offsets[dep.predictedTime]).toISOString()
        : dep.predictedTime,
  }));

  return { data };
}

/** Set up API route interception before navigation. Call this before page.goto(). */
export async function mockApi(page: Page, options: MockApiOptions = {}) {
  if (options.setup !== "fresh") await seedCompletedSetup(page);
  // These specs start inside a selected city. Model discovery and the saved
  // selection explicitly; production no longer chooses a default city.
  await page.route("**/api/cities", route => route.fulfill({json: {
    schemaVersion: 2, cities: [{id: "vilnius", name: "Vilnius", tz: "Europe/Vilnius",
      center: {lat: 54.6872, lon: 25.2797},
      bbox: {minLat: 54.6, minLon: 25.1, maxLat: 54.8, maxLon: 25.5}}],
  }}));
  if (options.setup !== "fresh") await page.addInitScript(() => {
    if (!localStorage.getItem("ptn-city")) {
      localStorage.setItem("ptn-city", JSON.stringify({state: {activeCity: {id: "vilnius"}}, version: 0}));
    }
  });

  // Optional self-hosted geocoder config (M9). The fixtures model a deployment
  // with NO server-side geocoder, so this static asset is ABSENT — which in
  // production (nginx / static hosting) returns a definitive 404. Stub that 404
  // explicitly: under the Vite dev server an unmatched path falls through to the
  // SPA shell (a 200 with an `index.html` body), and bootPoi's HYBRID
  // config-fetch reads that HTML body as an unparseable-but-non-empty 200 — a
  // NON-answer that DEFERS the POI corpus dispatch (residency hold), suppressing
  // the eager `/poi/manifest.json` fetch. The 404 is the faithful "no config
  // shipped" path: fail-open to eager, so boot fetches the manifest as it does
  // in production.
  await page.route("**/geocoder-config.json", (route) =>
    route.fulfill({ status: 404, body: "" })
  );

  // API URLs include a city prefix: /api/{cityId}/stops/all, etc.
  await page.route("**/api/**/stops/nearby*", (route) =>
    route.fulfill({ json: stopsNearby })
  );

  await page.route("**/api/**/stops/all*", (route) =>
    route.fulfill({ json: stopsAll })
  );

  legacyDepartureHits.set(page, 0);
  await page.route("**/api/**/departures*", (route) => {
    legacyDepartureHits.set(page, (legacyDepartureHits.get(page) ?? 0) + 1);
    return route.fulfill({ json: makeDepartures(options.catalogNow ?? new Date()) });
  });

  // ── Schedule-tile read path (the path production actually takes) ──────────
  //
  // Order matters: these are registered BEFORE the catch-all-ish matchers
  // above would ever apply, and Playwright resolves the most recently
  // registered matching handler first, so tile requests never reach the
  // departures stub.
  const tileMode = options.scheduleTile ?? "served";

  // Serve the real brotli-dec-wasm binary.
  //
  // `decompressBrotli` (services/brotliDecode.ts) tries
  // `DecompressionStream("br")` first and falls back to brotli-dec-wasm.
  // Chromium does NOT implement the "br" format, so the wasm IS the path under
  // Playwright — and an unmatched `*.wasm` request falls through to the Vite
  // SPA shell, so the browser receives `<!DOCTYPE html>` and throws
  // `WebAssembly.instantiate(): expected magic word 00 61 73 6d, found
  // 3c 21 44 4f`. Every tile then failed to decode, the read path burned its
  // cascade budget, emitted `bundle_thrash`, and fell back to the legacy route
  // — which renders perfectly good departures, so the whole tile path looked
  // fine while being completely bypassed.
  await page.route("**/*.wasm", async (route) => {
    if (!route.request().url().includes("brotli")) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: BROTLI_WASM_BYTES,
    });
  });

  if (tileMode === "unavailable") {
    // Deliberate fallback exercise: 503 is the status the read path maps to
    // `unavailable` on a cold client with no cached manifest (api.ts:313).
    await page.route("**/gtfs/manifest", (route) => route.fulfill({ status: 503, body: "" }));
    await page.route("**/gtfs/schedule-tile/**", (route) =>
      route.fulfill({ status: 503, body: "" })
    );
    await page.route("**/gtfs/rt-tile/**", (route) => route.fulfill({ status: 503, body: "" }));
  } else {
    await page.route("**/gtfs/manifest", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        // The read path reads the bundle hash from this header, not the body.
        headers: {
          "X-PT-Bundle-Hash": FIXTURE_BUNDLE_HASH,
          etag: `"${FIXTURE_BUNDLE_HASH}"`,
          ...(options.realtime !== undefined ? { "X-PT-Realtime": options.realtime } : {}),
        },
        body: JSON.stringify(buildFixtureManifest()),
      })
    );

    // Bytes are rebuilt per request so departures stay inside
    // `[now - 10min, now + lookAheadHours]` however long the suite takes.
    await page.route("**/gtfs/schedule-tile/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: {
          "X-PT-Bundle-Hash": FIXTURE_BUNDLE_HASH,
          // Deliberately NO `Content-Encoding: br`. Both real implementations
          // (packages/backend/src/routes/scheduleTile.ts:144 and
          // crates/pt-serve/src/app/schedule_tile.rs:62) serve the brotli bytes
          // as opaque application/octet-stream and let the client decompress
          // via services/brotliDecode.ts. Declaring the encoding would make the
          // browser transparently decompress, and the client's own
          // decompressBrotli would then throw on already-plain JSON.
        },
        body: buildFixtureTileBytes(options.catalogNow ?? new Date()),
      })
    );

    await page.route("**/gtfs/rt-tile/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "X-PT-Bundle-Hash": FIXTURE_BUNDLE_HASH },
        body: JSON.stringify(buildFixtureRtTile()),
      })
    );
  }

  await page.route("**/api/**/color-config", (route) =>
    route.fulfill({ json: colorConfig })
  );

  // Cover both /health (root), /health/ready (BackendStatus poll), and
  // /health/live (liveness probes). Using a single matcher keeps the stub
  // honest even as the backend adds new health sub-paths.
  await page.route("**/api/**/health**", (route) =>
    route.fulfill({ json: { status: "ok" } })
  );

  // Catalog bytes + their provenance. Wasm parity/cold-start tests opt into
  // the same v2 catalog so both engines see the same network; everything else gets the
  // Vilnius fixture the specs assert on.
  const catalogBytes =
    options.routingFixture === "ptb-matched"
      ? PTB_BYTES
      : catalogPtbFor(options.catalogNow ?? new Date(), options.catalogShapes ?? "advertised");
  const catalogBundleSha256 =
    options.routingFixture === "ptb-matched"
      ? PTB_MATCHED_GENERATION_ID
      : generationIdFor(catalogBytes);

  // pt-serve's `/ready`. `fetchCatalog` reads it twice around the bundle fetch
  // and refuses the pair if the generation moved between them, so this must be
  // stable for the life of the page. It also carries the shapes provenance:
  // the frontend builds the artifact URL from `servingShapesJsonSha256` and
  // then verifies sha256(body) itself, so the advertised hash has to be the
  // real digest of the body the shapes route below serves.
  await page.route("**/api/*/ready", (route) => {
    const city = new URL(route.request().url()).pathname.split("/")[2] ?? "vilnius";
    route.fulfill({
      json: {
        status: "ready",
        city,
        servingGenerationId: FIXTURE_BUNDLE_HASH,
        servingBundleSha256: catalogBundleSha256,
        // Fixed rather than 0: `parsePtbCatalogGeneration` derives
        // `generatedAt` from `nowUnixSecs - generationAgeSecs`, and a zero age
        // would date every fixture generation to the instant of the request.
        generationAgeSecs: 60,
        nowUnixSecs: Math.floor((options.catalogNow ?? new Date()).getTime() / 1000),
        cityTzIana: "Europe/Vilnius",
        // Both null together is how a generation with no shapes sidecar
        // reports itself; `parsePtbCatalogGeneration` rejects a half-set pair.
        servingShapesJsonSha256: options.catalogShapes === "absent" ? null : SHAPES_HASH,
        servingShapesJsonSizeBytes: options.catalogShapes === "absent" ? null : SHAPES_SIZE_BYTES,
        patternMode: PATTERN_MODE,
      },
    });
  });

  // Shapes artifact — served at any hashed path. The frontend verifies
  // sha256(body) === the hash `/ready` advertised, so a mismatched path is
  // still rejected client-side; we accept any hash in the URL for the happy
  // path and rely on the advertised hash matching this body.
  await page.route("**/gtfs/shapes/shapes-*.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: SHAPES_BODY,
    })
  );

  // PTB raptor-bundle (P6 panel devops M2). A conditional request may legally
  // receive 200 when the server ignores its validator. Use that response here
  // because Playwright route interception rejects 304 as redirect-class, while
  // retaining the shared-cache/revalidation behavior exercised by two-page E2E.
  await page.route("**/api/**/raptor-bundle", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        etag: `"${catalogBundleSha256}"`,
        vary: "Accept-Encoding",
        "cache-control": "public, max-age=0, must-revalidate",
      },
      body: catalogBytes,
    })
  );
}

/**
 * Set up the mock API at a stable in-service instant. Map/popup specs need
 * station cards to exist, so letting the wall clock drift past the fixture's
 * final trip makes them fail for an unrelated timetable reason. `catalogNow`
 * also anchors every time-relative response to the browser clock.
 */
export async function mockApiAtServiceTime(
  page: Page,
  options: MockApiOptions = {},
): Promise<void> {
  const serviceTime = new Date("2026-05-05T12:00:00+03:00");
  await page.clock.setFixedTime(serviceTime);
  await mockApi(page, { ...options, catalogNow: serviceTime });
}
