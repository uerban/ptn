# syntax=docker/dockerfile:1.7

# Global build args — declared before the first FROM so they are usable in
# FROM instructions (Docker scopes pre-FROM args globally; args declared
# inside a stage are not visible to a later FROM ${ARG}).
ARG RUST_BASE=docker.io/library/rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900
ARG PT_PRODUCER_GIT_SHA=unknown

# ---- Base stage: Node 22 alpine with pnpm ----
FROM docker.io/library/node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate
WORKDIR /app

# ---- Rust producer builder ----
# Compiles the producer binaries as musl x86_64
# static binary so it can be copied into the prod image without
# Alpine glibc/musl ABI concerns. The `csv-mmap` feature is the Phase A
# H3 winner (steady RSS reclaims via madvise(MADV_DONTNEED)).
FROM ${RUST_BASE} AS rust-ingest
# HTTP (not HTTPS) so the LAN apt-cacher-ng proxy can cache; integrity is
# preserved by APKINDEX signing. `id=` scopes the apk cache per base image so
# package downloads from different Alpine majors don't churn one shared dir.
RUN --mount=type=cache,id=apk-rust-1.97.1-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk musl-dev pkgconfig
WORKDIR /src
ARG PT_PRODUCER_GIT_SHA
ENV PT_PRODUCER_GIT_SHA=${PT_PRODUCER_GIT_SHA}
# CARGO_INCREMENTAL=0: forces a full release build instead of reusing
# fingerprinted artifacts from the cached target dir. Incremental codegen
# isn't byte-deterministic (codegen-unit ordering, ThinLTO partition shifts),
# so a populated target cache could make two builds at the same git SHA
# produce different binary bytes — which would silently weaken the
# reproducibility commitment in crates/pt-producer/Dockerfile.
ENV CARGO_INCREMENTAL=0
# Build from the root workspace so the image uses the same Cargo.lock as CI.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN rustup target add x86_64-unknown-linux-musl
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p pt-producer --target x86_64-unknown-linux-musl \
        --no-default-features --features csv-mmap && \
    cp /src/target/x86_64-unknown-linux-musl/release/pt-producer /tmp/pt-producer && \
    cp /src/target/x86_64-unknown-linux-musl/release/pt-build-transfers /tmp/pt-build-transfers && \
    strip /tmp/pt-producer /tmp/pt-build-transfers

# ---- Install stage: dependency installation ----
FROM base AS install
# See rust-ingest above for the HTTP-downgrade rationale.
RUN --mount=type=cache,id=apk-node-22-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=shared \
    pnpm install --frozen-lockfile

# ---- Dev stage: copy source and run dev server ----
FROM install AS dev
COPY packages/backend/ ./packages/backend/
COPY packages/shared/ ./packages/shared/
# scripts/build-info.mjs is required by @pt/backend's predev hook.
COPY scripts/ ./scripts/
COPY config/ ./config/
RUN pnpm --filter @pt/shared build
EXPOSE 3000
CMD ["pnpm", "--filter", "@pt/backend", "dev"]

# ---- Build stage: compile TypeScript ----
FROM install AS build
COPY packages/backend/ ./packages/backend/
COPY packages/shared/ ./packages/shared/
COPY scripts/ ./scripts/
COPY config/ ./config/
# GIT_SHA build-arg: CI passes ${{ github.sha }} so GET /api/version + X-App-Commit
# report the deployed commit. Unset → build-info.mjs falls back to "unknown".
# ENV promotes the ARG into the process environment so build-info.mjs can read
# process.env.GIT_SHA; this build stage is discarded, so it never reaches prod.
ARG GIT_SHA=
ENV GIT_SHA=${GIT_SHA}
RUN pnpm --filter @pt/shared build && pnpm --filter @pt/backend build

# ---- Prod-deps stage: strip dev dependencies ----
FROM install AS prod-deps
# `pnpm prune --prod` empties each workspace package's node_modules under
# pnpm 11 (it kept prod-dep symlinks under pnpm 9), which left the prod image
# unable to resolve fastify/@pt/shared. Re-resolving prod-only against the
# already-populated store keeps the per-package symlinks intact and runs
# offline (frozen + warm store).
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=shared \
    pnpm install --prod --frozen-lockfile

# ---- Prod stage: minimal runtime ----
FROM docker.io/library/node:22-alpine AS prod
# See rust-ingest above for the HTTP-downgrade rationale.
RUN --mount=type=cache,id=apk-node-22-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk tzdata jq && \
    corepack enable && corepack prepare pnpm@11.2.2 --activate
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/package.json ./packages/backend/
COPY --from=prod-deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
# NOTE: no `COPY packages/backend/feeds/` — that dir is a local-only, gitignored
# staging spot for manually-fetched GTFS zips, which the prod runtime never reads
# (boot loads GTFS via PT_DATA_ROOT / PT_BUNDLE_PATH / GTFS_STATIC_URL in
# pt-startup.sh, not a bundled zip). The previous COPY bundled the unused Yerevan
# feed; dropped to keep the image lean. Do not re-add it to ship a fixture into prod.
COPY --from=rust-ingest /tmp/pt-producer /usr/local/bin/pt-producer
COPY --from=rust-ingest /tmp/pt-build-transfers /usr/local/bin/pt-build-transfers
# Required city inputs are mounted read-only from the independent manager.
# No city extract, transfer source or address corpus is copied into this image.
COPY packages/backend/scripts/pt-startup.sh /sbin/pt-startup.sh
COPY packages/backend/scripts/color-artifacts-gen.mjs /app/packages/backend/scripts/color-artifacts-gen.mjs
COPY packages/backend/scripts/schedule-tile-gen.mjs /app/packages/backend/scripts/schedule-tile-gen.mjs
RUN chmod +x /sbin/pt-startup.sh
EXPOSE 3000
ENTRYPOINT ["/sbin/pt-startup.sh"]
