# `pt-wasm`

Thin `wasm-bindgen` wrapper over `pt-core` (the RAPTOR engine). Ships a `PtRouter` JS handle that decodes a `.ptb` byte buffer and serves itinerary queries — the same engine `pt-serve` runs natively, just compiled for `wasm32-unknown-unknown`.

## Layout

| File | Responsibility |
|------|----------------|
| `src/lib.rs` | `PtRouter` opaque handle, lifecycle (new / plan / isAlive / manual_free) |
| `src/query.rs` | `WasmQuery` deserialization + `stop_id` ↔ index boundary |
| `src/output.rs` | `Itinerary[Leg]` → tagged-union `RaptorItinerary[]` matching `@pt/shared` |
| `src/error.rs` | `PtbError` → `JsError` mapping |
| `tests/smoke.mjs` | Node WebAssembly correctness smoke (Tasks 2-6) |
| `tests/three_way.mjs` | `wasm ≡ native` over committed P2 differential fixtures |
| `tests/latency_baseline.mjs` | Advisory decode + first-plan p50/p95 |

## Build

The crate is **excluded from `default-members`** (root `Cargo.toml`), so `cargo build` from the workspace root won't try to compile it for the host target. Always build via `wasm-pack`:

```bash
# From repo root, with cargo on PATH (~/.cargo/bin + ~/.rustup/toolchains/<pin>/bin):
cd crates/pt-wasm

# Release builds for both targets:
wasm-pack build --release --target nodejs --out-dir pkg-node   # for tests
wasm-pack build --release --target web    --out-dir pkg-web    # for the frontend
```

Both outputs are gitignored. The release build sets size-optimisation profile knobs as STEP-LEVEL env vars (`CARGO_PROFILE_RELEASE_PANIC=abort`, `OPT_LEVEL=z`, `LTO=true`, `CODEGEN_UNITS=1`, `STRIP=true`); a local `wasm-pack build --release` WITHOUT those envs produces a ~3-5× larger artifact and may exceed the 250 KB gzip ceiling. To match the CI build locally:

```bash
CARGO_PROFILE_RELEASE_PANIC=abort \
CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
CARGO_PROFILE_RELEASE_LTO=true \
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
CARGO_PROFILE_RELEASE_STRIP=true \
wasm-pack build --release --target web --out-dir pkg-web
```

## Test

```bash
cd crates/pt-wasm
node tests/smoke.mjs           # correctness + tagged-union shape + isAlive contract + mobilityProfile pin
node tests/three_way.mjs       # wasm ≡ native over P2 fixtures (21 tuples, 3 skipped pending P6 set_transfers)
node tests/latency_baseline.mjs  # advisory perf
```

`three_way.mjs` requires `pt-core-emit` to be built (`cargo build -p pt-core-emit --release`); it spawns the native binary as a subprocess.

## Frontend workspace link

`pkg-web/` is declared in the root `pnpm-workspace.yaml`, so `packages/frontend/package.json`'s `"@pt/wasm": "workspace:*"` dep resolves to the wasm-pack output. **`pkg-web/` must be built before `pnpm install`** — pnpm errors on missing `package.json` in a workspace member dir. The CI workflow handles this ordering; local devs need to run `wasm-pack build --target web` once before their first `pnpm install`.

## Public surface

```typescript
class PtRouter {
  constructor(buf: Uint8Array);                       // throws JsError on corrupt buffer
  plan(query: WasmQuery): RaptorItinerary[];          // throws JsError on unknown stopId / bad date / engine error
  isAlive(): boolean;                                  // sub-ms liveness probe; NEVER throws (incl. post-free)
  free(): void;                                        // soft drop — flag flip; Rust Drop defers to JS GC
}

interface WasmQuery {
  entryStops: { stopId: string; walkSecs: number }[];
  exitStops: { stopId: string; walkSecs: number }[];
  date: string;            // "YYYYMMDD" — service-day resolves inside the engine
  departureSecs: number;
  maxRounds?: number;
  mobilityProfile?: "default" | "wheelchair" | "bicycle";  // case-sensitive
  excludedModes?: number[];  // GTFS route_type integers
  walkSpeedMps?: number;     // transfer-walk speed, 0.1–10; absent: 0.8 wheelchair, else 1.25
  minTransferSecs?: number;  // floor where no transfers.txt rule sets one, 0–3600; absent: 120
}
```

Output `RaptorItinerary[]` matches `@pt/shared::RaptorItinerary` — see `output.rs` for the field shape. Walk legs and transit legs share `{fromStopId, toStopId}`; transit legs additionally carry `{routeId, routeShortName, mode, tripId, intermediateStops}`.

## Known limitations / P6 follow-ups

- **No transfers in P5.** `plan()` passes `None` for the pedestrian-transfer table; footpath relaxation is off. P6 adds `set_transfers(buf)`.
- **`free()` is a soft drop.** Wasm memory persists until JS GC fires the `FinalizationRegistry` callback.
- **Display enrichment, RT overlay, overnight service day** all stay client-side per master §5.
