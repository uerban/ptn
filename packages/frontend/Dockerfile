# syntax=docker/dockerfile:1.7

# Two Rust toolchains in this stage, matching what pt-wasm-gate.yml does:
#   - The base image's default stable (currently 1.88+) for `cargo install
#     wasm-bindgen-cli/wasm-pack` — their transitive `time` crate requires
#     rustc 1.88+; install them independently from the repository compiler.
#   - the exact version from rust-toolchain.toml for the wasm-pack build itself — auto-
#     installed by rustup the first time cargo runs in /src.
ARG RUST_WASM_BASE=docker.io/library/rust:alpine

# ---- Base stage: Node 22 alpine with pnpm ----
FROM docker.io/library/node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate
WORKDIR /app

# ---- Rust wasm builder ----
# Builds the `pt-wasm` crate to its wasm-pack `pkg-web` output. P6's
# frontend imports `pt-wasm` (workspace-linked to crates/pt-wasm/pkg-web
# in pnpm-workspace.yaml) so both `pnpm install` (workspace resolution)
# and `pnpm --filter @pt/frontend build` (`tsc -b` module resolution +
# vite bundling) require `pkg-web` on disk. Mirrors the backend Dockerfile's
# rust-ingest pattern: builds inside the image so a clean `docker build`
# works without runner-side pre-staging.
#
# Pinned wasm-bindgen-cli + wasm-pack versions match pt-wasm-gate.yml so
# the bytes this image ships are the same profile that CI validates.
# Cold cache: ~3-4 min for wasm-bindgen-cli + ~4 min for wasm-pack + ~5 min
# for the rustup toolchain download → the self-deploy compose-up watchdog is sized
# to fit this comfortably (see self-deploy-smoke.yml).
FROM ${RUST_WASM_BASE} AS rust-wasm
RUN --mount=type=cache,id=apk-rust-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk musl-dev pkgconfig
ENV CARGO_INCREMENTAL=0
# CLI installs run with the image's default stable Rust. CWD is /, no
# rust-toolchain.toml in any parent, so rustup uses the system default.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    cargo install wasm-bindgen-cli --version 0.2.122 --locked && \
    cargo install wasm-pack --version 0.15.0 --locked
WORKDIR /src
# pt-wasm's path-deps (pt-core, pt-shared) must be at the relative offsets
# Cargo.toml expects. Root workspace files are needed for cargo resolution;
# the workspace glob `crates/*` requires every crate dir to be present
# (cargo validates membership at resolution time), even though wasm-pack
# only builds pt-wasm. The rust-wasm stage is discarded — only pkg-web is
# COPYed out — so the extra source is throw-away weight.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ ./crates/
# Force rustup to read /src/rust-toolchain.toml now: installs the exact pin + the
# wasm32-unknown-unknown target before wasm-pack runs (which would also
# trigger it, but doing it explicitly makes the install a separate cached
# layer and surfaces errors at this step rather than mid-build).
RUN rustup show
WORKDIR /src/crates/pt-wasm
# Profile env matches pt-wasm-gate.yml exactly (panic=abort + opt-level=z + LTO).
ENV CARGO_PROFILE_RELEASE_PANIC=abort \
    CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
    CARGO_PROFILE_RELEASE_LTO=true \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_STRIP=true
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    wasm-pack build --release --target web --out-dir pkg-web

# Arrive-by package; set PTN_ARRIVE_BY_EXPERIMENT=0 to build without it.
ARG PTN_ARRIVE_BY_EXPERIMENT=1
ARG GIT_SHA=
COPY scripts/build-pt-wasm-arrive-by.mjs /src/scripts/build-pt-wasm-arrive-by.mjs
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    if [ "$PTN_ARRIVE_BY_EXPERIMENT" = "1" ]; then \
      apk add --no-cache nodejs git binaryen && \
      cd /src && GIT_SHA="${GIT_SHA:-unknown}" node scripts/build-pt-wasm-arrive-by.mjs; \
    else mkdir -p /src/crates/pt-wasm/pkg-web-arrive-by; \
    fi

# ---- Install stage: dependency installation ----
FROM base AS install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/shared/package.json ./packages/shared/package.json
# pnpm-workspace.yaml lists crates/pt-wasm/pkg-web as a workspace member;
# bring it in before `pnpm install` so the `pt-wasm: workspace:*` dep
# resolves to a real package with `.d.ts` types vite can bundle.
COPY --from=rust-wasm /src/crates/pt-wasm/pkg-web ./crates/pt-wasm/pkg-web
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=shared \
    pnpm install --frozen-lockfile

# ---- Dev stage: copy source and run dev server ----
FROM install AS dev
COPY packages/frontend/ ./packages/frontend/
COPY packages/shared/ ./packages/shared/
# vite.config.ts imports ../../scripts/build-info.mjs.
COPY scripts/ ./scripts/
RUN pnpm --filter @pt/shared build
EXPOSE 5173
CMD ["pnpm", "--filter", "@pt/frontend", "dev", "--host", "0.0.0.0"]

# ---- Build stage: compile and bundle ----
FROM install AS build
# git lets build-info.mjs (invoked by vite.config.ts) resolve the deployed
# commit from the .git Portainer leaves in the build context (bind-mounted
# below). Same mechanism as packages/backend/Dockerfile — see it for rationale.
RUN --mount=type=cache,id=apk-node-22-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk git
COPY packages/frontend/ ./packages/frontend/
COPY packages/shared/ ./packages/shared/
COPY scripts/ ./scripts/
# GIT_SHA build-arg: CI passes ${{ github.sha }} so the VersionBlock reports the
# deployed commit. Unset → build-info.mjs falls back to "unknown".
# ENV promotes the ARG into the process environment so build-info.mjs can read
# process.env.GIT_SHA; this build stage is discarded, so it never reaches prod.
ARG GIT_SHA=
ENV GIT_SHA=${GIT_SHA}
COPY --from=rust-wasm /src/crates/pt-wasm/pkg-web-arrive-by ./crates/pt-wasm/pkg-web-arrive-by
ARG PTN_ARRIVE_BY_EXPERIMENT=1
ENV PTN_ARRIVE_BY_EXPERIMENT=${PTN_ARRIVE_BY_EXPERIMENT}
ARG VITE_PT_TBILISI_ENABLED=0
ENV VITE_PT_TBILISI_ENABLED=${VITE_PT_TBILISI_ENABLED}
RUN pnpm --filter @pt/shared build && pnpm --filter @pt/frontend build

# City artifacts are installed by the deployment's independent manager.
# The ordinary source COPY cannot include them: .dockerignore excludes generated
# public POI/PTWG trees and PBF caches from every image build context.

# Export with --target static-assets --output type=local,dest=... for any HTTP
# server. This target contains the PWA only and has no nginx/runtime dependency.
FROM scratch AS static-assets
COPY --from=build /app/packages/frontend/dist /

