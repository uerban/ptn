# syntax=docker/dockerfile:1.7

# pt-serve: minimal Rust HTTP binary for the P3 RSS bench.
# Builds a musl x86_64 static binary mirroring the prod Dockerfile's rust-ingest stage.
# The resulting image runs the binary directly — no runtime deps, no shell required.
ARG RUST_BASE=rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900
ARG PT_SERVE_GIT_SHA=unknown

FROM ${RUST_BASE} AS builder
# HTTP (not HTTPS) so the LAN apt-cacher-ng proxy can cache; integrity is
# preserved by APKINDEX signing. `id=` scopes the apk cache per base image.
RUN --mount=type=cache,id=apk-rust-1.97.1-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk musl-dev
WORKDIR /src
ARG PT_SERVE_GIT_SHA
ENV PT_SERVE_GIT_SHA=${PT_SERVE_GIT_SHA}
# CARGO_INCREMENTAL=0: forces a full release build instead of reusing
# fingerprinted artifacts from the cached /src/target. Incremental codegen
# isn't byte-deterministic, so a populated target cache could let two builds
# at the same git SHA produce different binary bytes — matching the policy
# in packages/backend/Dockerfile's rust-ingest stage.
ENV CARGO_INCREMENTAL=0
# Copy workspace manifests and lock file for layer caching
COPY Cargo.toml Cargo.lock ./
COPY crates/pt-core/Cargo.toml ./crates/pt-core/
COPY crates/pt-core-emit/Cargo.toml ./crates/pt-core-emit/
COPY crates/pt-serve/Cargo.toml ./crates/pt-serve/
# pt-shared was added in P4 — manifest types, fsync helper, MockClock. pt-serve depends on it;
# without this line the layer-cache pre-fetch is incomplete and a fresh `cargo build` still works
# (the subsequent COPY crates/ pulls everything) but the dep-cache miss rebuilds the world on any
# unrelated crate change.
COPY crates/pt-shared/Cargo.toml ./crates/pt-shared/
# Copy all crate sources
COPY crates/ ./crates/
# Build-info headers use backend's declared application version.
COPY packages/backend/package.json ./packages/backend/package.json
# pt-serve's build.rs greps `packages/backend/src/health/feedStaleConstants.ts` (relative path
# `../../packages/backend/src/health/feedStaleConstants.ts` from crates/pt-serve/) to pin
# FEED_STALE_DAYS across the Rust↔Node boundary. Without this COPY, the build.rs panics at the
# read_to_string and `cargo build -p pt-serve` exits 101. Mirrored layout — the path-grep is
# load-bearing, not the working directory.
COPY packages/backend/src/health/feedStaleConstants.ts ./packages/backend/src/health/feedStaleConstants.ts
# build.rs also greps packages/shared/src/constants/defaults.ts to pin the
# GTFS-RT poll-interval default against the Node constant — same mirrored-
# layout reasoning as the feedStaleConstants COPY above.
COPY packages/shared/src/constants/defaults.ts ./packages/shared/src/constants/defaults.ts
# POI corpus validation pins the canonical k-anonymity floor from this file.
COPY packages/shared/src/poi/tileParams.ts ./packages/shared/src/poi/tileParams.ts
RUN rustup target add x86_64-unknown-linux-musl
# Cache mounts don't persist across RUNs, so the binary must be copied to
# /tmp before strip; the downstream `COPY --from=builder` then points at /tmp.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build -p pt-serve --release --locked --target x86_64-unknown-linux-musl && \
    cp /src/target/x86_64-unknown-linux-musl/release/pt-serve /tmp/pt-serve && \
    strip /tmp/pt-serve

FROM scratch
COPY --from=builder /tmp/pt-serve /pt-serve
ENTRYPOINT ["/pt-serve"]
