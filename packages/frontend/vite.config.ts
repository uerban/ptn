import { defineConfig, createLogger, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { readBuildInfo } from "../../scripts/build-info.mjs";
import { runtimeCaching } from "./src/sw/runtimeCaching.js";
import { precacheGlobIgnores } from "./src/sw/precache.js";

const buildInfo = readBuildInfo(new URL(".", import.meta.url).pathname);

const PUBLIC_DIR = resolve(new URL(".", import.meta.url).pathname, "public");

/**
 * Serve `public/poi/*.br` as opaque bytes in dev.
 *
 * Vite's static middleware sets `Content-Encoding: br` from the file extension
 * alone — a plain-text file named `.br` gets the header too. The browser then
 * transparently decodes the body, and `fetchPoiBundle`, which decompresses the
 * POI bundle itself, is handed already-plain bytes and reports "Brotli
 * decompress failed" at every boot. Production serves these raw, which is why
 * the manual decompress is there at all, so dev is the side that is wrong.
 *
 * Serving the file here rather than stripping the header afterwards keeps this
 * from depending on middleware ordering or on patching `res.setHeader`.
 */
function devPoiManifest() {
  const dir = resolve(PUBLIC_DIR, "poi");
  if (!existsSync(dir)) return null;
  const bundles = readdirSync(dir).filter(name => /^[a-z][a-z0-9-]*(\.loose)?\.br$/.test(name)).sort().map(filename => {
    const body = readFileSync(resolve(dir, filename));
    return {
      cityId: filename.replace(/(\.loose)?\.br$/, ""),
      filename,
      sizeBytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  });
  if (bundles.length === 0) return null;
  const release = createHash("sha256").update(JSON.stringify(bundles)).digest("hex");
  return { schemaVersion: 1, activationRevision: 1, baseUrl: `/poi/releases/${release}/`, bundles };
}

function serveBrotliBundlesRaw(): Plugin {
  return {
    name: "ptn-dev-serve-br-raw",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let url = req.url?.split("?")[0];
        if (url === "/poi/manifest.json") {
          // Production serves a managed manifest naming immutable release
          // URLs. Dev has only the committed public/poi bundles, so describe
          // those (404 when there are none, as a deployment without POI).
          const manifest = devPoiManifest();
          if (!manifest) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-cache");
          res.end(JSON.stringify(manifest));
          return;
        }
        const release = url?.match(/^\/poi\/releases\/[0-9a-f]{64}\/([\w.-]+\.br)$/);
        if (release) url = `/poi/${release[1]}`;
        if (!url || !/^\/poi\/[\w.-]+\.br$/.test(url)) return next();
        const file = resolve(PUBLIC_DIR, url.slice(1));
        // Defence in depth against a traversing path reaching outside public/.
        if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return next();
        const body = readFileSync(file);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", String(body.byteLength));
        res.setHeader("Cache-Control", "no-cache");
        res.end(body);
      });
    },
  };
}

// Quiet the dev-server's proxy-error flood when no backend is running — e.g. the
// privacy harness boots `pnpm dev` with no API, and the app polls
// `/api/<city>/version` on boot, so Vite logs a full `http proxy error` +
// AggregateError stack for every failed request. Collapse that to one concise
// line and suppress the repeats; all other logging passes through untouched.
// Dev-server only — the request still genuinely fails (no stubbing), and prod
// is unaffected. (Vite calls a proxy's `configure()` before attaching its own
// error listener, so the listener can't be replaced there — the supported seam
// is `customLogger`.)
const logger = createLogger();
const baseError = logger.error.bind(logger);
let proxyErrorLogged = false;
logger.error = (msg, opts) => {
  if (typeof msg === "string" && msg.includes("http proxy error")) {
    if (proxyErrorLogged) return;
    proxyErrorLogged = true;
    baseError(
      "[vite] /api proxy error: backend unreachable — is the API running? (further occurrences suppressed)",
      { timestamp: true },
    );
    return;
  }
  baseError(msg, opts);
};

/**
 * Opt-in arrive-by experiment, build-time only: `PTN_ARRIVE_BY_EXPERIMENT=1`
 * swaps the router worker entry for one that also hosts the experimental
 * arrive-by owner, resolves its WASM package (built by
 * `scripts/build-pt-wasm-arrive-by.mjs`), and swaps Search's UI gate for the
 * Arrive-by toolbar and results. Without the flag nothing here applies, and
 * the default build never sees the experiment.
 */
function arriveByExperimentAliases() {
  if (process.env.PTN_ARRIVE_BY_EXPERIMENT !== "1") return [];
  const glue = new URL("../../crates/pt-wasm/pkg-web-arrive-by/pt_arrive_by.js", import.meta.url).pathname;
  if (!existsSync(glue)) {
    throw new Error(`PTN_ARRIVE_BY_EXPERIMENT=1 needs ${glue}; run: node scripts/build-pt-wasm-arrive-by.mjs`);
  }
  return [
    {
      find: /^\.\/ptRouterWorkerEntry\.ts$/,
      replacement: new URL("./src/services/ptRouterWorkerEntry.arriveBy.ts", import.meta.url).pathname,
    },
    { find: /^@pt\/wasm-arrive-by$/, replacement: glue },
    {
      find: /^\.\.\/components\/ArriveBy\/arriveByExperiment\.ts$/,
      replacement: new URL("./src/components/ArriveBy/arriveByExperiment.arriveBy.ts", import.meta.url).pathname,
    },
  ];
}

const REFERRER_POLICY_HEADERS = { "Referrer-Policy": "strict-origin" };

export default defineConfig({
  customLogger: logger,
  resolve: {
    alias: [
      {
        find: /^@pt\/shared\/address-search$/,
        replacement: new URL("../shared/src/addressSearch/index.ts", import.meta.url).pathname,
      },
      ...arriveByExperimentAliases(),
    ],
  },
  plugins: [
    serveBrotliBundlesRaw(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      includeAssets: [
        "favicon.svg",
        "favicon.ico",
        "apple-touch-icon.png",
        "apple-touch-icon-precomposed.png",
      ],
      manifest: {
        name: "PTN/HU·LO — Public Transport Navigator",
        short_name: "PTN/HU·LO",
        description:
          "Humbly yours — local and open public transport navigation",
        theme_color: "#2460A7",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      devOptions: {
        enabled: true,
      },
      workbox: {
        // .pbf included so glyph subsets under public/glyphs/ are precached
        // for the offline meta-map — see the meta map offline notes.
        // .wasm included so the lazy pt-wasm chunk is precached;
        // without it, offline first-load of the wasm engine breaks because
        // the SW serves the surrounding .js bundle from precache but the
        // browser still hits the network for the .wasm sibling.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,pbf,wasm}"],
        // Workbox precaches every emitted .js, which un-splits the locale
        // chunks: all six were fetched at install so five could go unused.
        // These are served by a CacheFirst runtime rule instead — see
        // src/sw/precache.ts for the pairing, which precache.test.ts checks.
        globIgnores: precacheGlobIgnores,
        // cleanupOutdatedCaches actually only cleans Workbox's *precache*
        // caches (`workbox-precache-v2-<scope>`) — runtime caches (named via
        // the runtimeCaching `cacheName` field in src/sw/runtimeCaching.ts)
        // are NOT touched.
        // Keeping it on is still useful for precache hygiene on every
        // deploy. The runtime-cache equivalent is the manual cacheName bump
        // (see `api-stops-cache-v1` in runtimeCaching.ts): the new SW
        // reads/writes only the new cache name, so a poisoned older
        // cache becomes inert; it lingers in CacheStorage until
        // the browser evicts under quota pressure, which is harmless
        // functionally. Propagation: with `registerType: "prompt"`, the new
        // SW only activates after the user accepts the in-app update prompt,
        // so the orphan eviction takes one user-initiated update cycle per
        // device.
        cleanupOutdatedCaches: true,
        runtimeCaching,
      },
    }),
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildInfo.version),
    __BUILD_COMMIT__: JSON.stringify(buildInfo.commit),
    __BUILD_AT__: JSON.stringify(buildInfo.builtAt),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Shared guidance lifecycle/client boundary. Count this eager chunk
          // in the first-paint budget as well as total JS; the worker and
          // no-Worker implementation remain separate lazy payloads.
          "walkGraphClient": ["./src/services/walkGraphClient.ts"],
          // The catalog decoder is shared by the worker's no-Worker fallback
          // and the routing graph's @pt/shared barrel. Claim it before the
          // greedy raptor chunks so PTB decoding does not consume the routing
          // adapter's independent size budget.
          "ptbCatalogCodec": ["@pt/shared/ptb"],
          // Pin the @pt/shared transit module (getDeparturesFromTile + the
          // schedule-tile codec) into its own chunk. Listed FIRST so it claims
          // those modules before the greedy, size-budgeted raptor chunks below.
          // The `@pt/shared` barrel `export *`s `./transit`, and the raptor
          // graph (wasmPlanner → raptorWasm, raptorIndex → transfersArtifact →
          // …) reaches that barrel through many value-import edges. Before
          // Stage B the transit codec was dead (tree-shaken); the schedule-tile
          // read-path cutover makes it LIVE, so Rollup's greedy chunking would
          // otherwise fold ~2 kB of departures-merge code into
          // `wasmPlanner`/`raptorWasm` and blow the `raptorWasm adapter +
          // planner` budget. Pinning keeps the codec where it belongs — a
          // small shared chunk loaded by its actual consumers (the read path +
          // the next-departure projections), not the routing adapter.
          "scheduleTileCodec": ["@pt/shared/transit"],
          // Same story as `scheduleTileCodec`, one module over: the
          // `@pt/shared` barrel `export *`s `../proto/route-update.js`,
          // which builds its protobuf schema (`new protobuf.Root()` +
          // `Type`/`Field`) at module scope. Those constructor calls are
          // side effects Rollup cannot drop, so the RT wire codec —
          // protobufjs/light plus its `long` dep, ~29 kB gzipped — stayed
          // LIVE in whichever chunk first reached the barrel, which is the
          // greedy `wasmPlanner` below. Its only caller is
          // `services/api.ts` (`decodeRouteUpdate` on the `/rt` fetch); no
          // routing code touches it. That parked ~64% of the `raptorWasm
          // adapter + planner` budget on the RT decoder and left the
          // gate hostage to protobufjs patch bumps — 8.5.0 → 8.6.6 alone
          // added ~1 kB gzipped and blew it (#502).
          //
          // Pinning it here (FIRST, before the greedy raptor chunks) is an
          // attribution fix, not a payload cut: the same modules still load
          // eagerly (the entry chunk statically reaches both), one file
          // heavier by ~0.5 kB of chunk overhead. What changes is that the
          // routing budget below now measures routing code, so the adapter
          // can be gated tightly (18 kB) without a vendor codec's release
          // cadence deciding whether CI is green.
          "rtProtoCodec": ["@pt/shared/proto"],
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-map": ["maplibre-gl"],
          "vendor-db": ["dexie", "dexie-react-hooks"],
          "vendor-state": ["zustand"],
          // Pin the pt-wasm adapter + planning boundary into their own chunks so
          // `.size-limit.json` can budget them separately (P6 panel devops
          // M4 — non-wasm regressions must not be masked by wasm headroom,
          // and the adapter must not silently bloat). Rollup keys the
          // emitted chunk filename off the manualChunks key, so these
          // names appear as `raptorWasm-<hash>.js` and
          // `wasmPlanner-<hash>.js` in dist/assets and match the
          // size-limit glob pattern.
          //
          // Side-effect (intentional): forcing raptorWasm.ts into its
          // own chunk also delivers panel architect B1's "lazy adapter"
          // promise. wasmLifecycle statically imports buildPtRouter from
          // it, which previously hoisted raptorWasm into the eager
          // entry chunk; the manualChunk override breaks that hoist.
          "raptorWasm": ["./src/services/raptorWasm.ts"],
          "wasmPlanner": ["./src/services/wasmPlanner.ts"],
        },
      },
    },
  },
  // brotli-dec-wasm ships its .wasm next to its JS entry and fetches it at
  // module init via `new URL(..., import.meta.url)`. Pre-bundling rewrites that
  // URL to `node_modules/.vite/deps/`, where esbuild never copied the binary —
  // the dev server's SPA fallback then answers with index.html and 200, so the
  // failure surfaces as `WebAssembly.instantiate(): expected magic word` rather
  // than a 404. Excluding it from the optimizer leaves the entry (and its
  // sibling .wasm) served from node_modules, where both resolve.
  optimizeDeps: {
    exclude: ["brotli-dec-wasm"],
  },

  // Page addresses can name stops, lines and coordinates. The deployment
  // sends the same header (examples/native/Caddyfile); index.html carries it
  // as a meta tag for hosts that do not.
  preview: {
    headers: REFERRER_POLICY_HEADERS,
  },
  server: {
    headers: REFERRER_POLICY_HEADERS,
    proxy: {
      // The POI route is intentionally cityless; preserve its path before the
      // generic /api/<transit-city>/ prefix rewrite below.
      "/api/gtfs/poi-tile": {
        target: process.env.BACKEND_URL || "http://localhost:3000",
        changeOrigin: true,
      },
      "/api": {
        target: process.env.BACKEND_URL || "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/[^/]+/, "/api"),
      },
    },
  },
});
