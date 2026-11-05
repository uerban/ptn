# PTN — Public Transport Navigator

PTN is a privacy-first, offline-capable transit PWA whose route planning runs
on the device. The browser downloads a city's compiled schedule and plans
journeys locally with a RAPTOR engine compiled to WebAssembly; the trip query
never reaches the server.

Server side is Rust: `pt-producer` compiles GTFS feeds into binary PTB
generations, and `pt-serve` embeds the same engine (`pt-core`) to serve
planning and data endpoints. A small Node `adapter-shim` proxies third-party
planner routes.

This repository holds the source code and the instructions to build it.
General hosting examples live in [examples/native](examples/native/README.md)
and [docker](docker/README.md). Private deployment configuration and published
city data live separately.

## Layout

| Path | What |
|---|---|
| `crates/pt-core` | RAPTOR engine and PTB bundle format |
| `crates/pt-core-emit` | PTB writer |
| `crates/pt-shared` | Types shared by producer, server and clients |
| `crates/pt-producer` | GTFS → PTB producer (`pt-producer`, `pt-build-transfers`) |
| `crates/pt-serve` | HTTP server (`pt-serve`) |
| `crates/pt-walk` | Walking graph builder (`pt-walk-build`) |
| `crates/pt-geocode` | Address search index |
| `crates/pt-artifacts` | Signed OSM artifact manager (`pt-artifacts`) |
| `crates/pt-wasm` | Engine for the browser (wasm-bindgen) |
| `packages/frontend` | React PWA |
| `packages/backend` | Node adapter shim and POI bundle builder |
| `packages/shared` | TypeScript types shared by frontend and backend |

## Prerequisites

- Rust toolchain pinned in `rust-toolchain.toml` (rustup installs it on first
  use), plus the `wasm32-unknown-unknown` target
- [wasm-pack](https://github.com/wasm-bindgen/wasm-pack)
- Node.js 22.22+ with Corepack (`corepack enable` provides the pinned pnpm)
- Python 3.11+ for release packaging
- Docker or Podman, only for container images

Source builds also need a C/C++ compiler and Python for native dependencies.
On Debian/Ubuntu, install `build-essential`, `pkg-config`, `libssl-dev`, and
`python3` before building.

## Build

Build the browser engine before `pnpm install`, because
`crates/pt-wasm/pkg-web` is a workspace package:

```bash
corepack enable
cargo install wasm-pack --version 0.15.0 --locked
rustup target add wasm32-unknown-unknown

cd crates/pt-wasm
CARGO_PROFILE_RELEASE_PANIC=abort \
CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
CARGO_PROFILE_RELEASE_LTO=true \
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
  wasm-pack build --release --target web --out-dir pkg-web
cd -

pnpm install --frozen-lockfile
pnpm build                                  # frontend → packages/frontend/dist
```

Native binaries:

```bash
cargo build --release --locked --workspace   # target/release/{pt-serve,pt-producer,pt-artifacts,...}
```

The ordinary PWA build does not need the opt-in arrive-by package.

## Installable archive

The release matrix covers Linux x86_64, ARMv6 hard-float (Raspberry Pi 1),
AArch64 (64-bit Raspberry Pi 3+), and macOS Apple Silicon and Intel. All Linux
archives use statically linked musl binaries. See
[release platforms](docs/release-platforms.md) for archive names, validation
coverage, and Raspberry Pi limits. `v0.1.0` ships Linux x86_64 only.

On an x86_64 Linux build host,
install `musl-tools` and `pkg-config` (Debian/Ubuntu package names), then build
the static binaries from the same source revision as the PWA:

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release --locked --target x86_64-unknown-linux-musl \
  -p pt-serve -p pt-producer -p pt-artifacts -p pt-walk --features pt-walk/build
node scripts/package-osm-builder.mjs
python3 scripts/package-release.py --platform linux-x86_64 \
  --bin-dir target/x86_64-unknown-linux-musl/release
```

This writes `release/ptn-linux-x86_64.tar.gz` and its SHA-256 checksum. The
archive includes six matching native tools, the PWA, licenses, a standalone
local OSM builder, and native hosting instructions. A release host needs no
Rust compiler or source checkout. Node and osmium-tool are needed only when
building OSM data locally; downloaded signed catalogs use `pt-artifacts`.

On macOS, build the same packages with `--target aarch64-apple-darwin` or
`--target x86_64-apple-darwin` and package with `--platform darwin-arm64` or
`--platform darwin-x86_64`, respectively. Set `MACOSX_DEPLOYMENT_TARGET=13.0`
for the build. Cross-compiling Linux tools also requires a C compiler for the
chosen musl target; the release workflow installs pinned toolchains with
`scripts/install-musl-toolchain.sh`. Merely installing a Rust target does not
provide its C compiler.

For a containerized binary build instead, from the source root:

```sh
docker buildx build --platform linux/amd64 -f docker/release-binaries.Dockerfile \
  --output type=local,dest=release-bin .
node scripts/package-osm-builder.mjs
python3 scripts/package-release.py --platform linux-x86_64 --bin-dir release-bin
```

Both paths use the previously built PWA. Follow the
[native](examples/native/README.md) or [Docker](docker/README.md) guide after
packaging. [Validation results](examples/VALIDATION.md) identify any remaining
release blockers; a successful compile alone does not certify hosting.

## Docker hosting

The [reference Docker guide](docker/README.md) runs the installable archive
with persistent city data and the same HTTP/HTTPS proxy as the native host.
Images contain no city data; the host installs signed OSM artifacts and
downloads GTFS during initialization.

## Test

```bash
cargo test --workspace
pnpm test
pnpm typecheck
```

## License

Unless a file or crate states otherwise, PTN is AGPL-3.0-or-later. The engine
crates `pt-core`, `pt-shared` and `pt-core-emit` are `MIT OR Apache-2.0`.
Transit feeds, OpenStreetMap data, fonts and other third-party material keep
their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

GTFS can come directly from its publisher or from a pinned community preparation
recipe. See [source-driven feed ingestion](docs/gtfs-sources.md). The refresh
runtime is included in native archives and the Docker host image.
