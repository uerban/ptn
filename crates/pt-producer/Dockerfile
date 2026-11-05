# syntax=docker/dockerfile:1.7

# Pin RUST_BASE and ALPINE_BASE to image digests when comparing measurements.
# Cargo.lock and --locked pin Rust dependencies; PT_PRODUCER_GIT_SHA identifies
# the source revision. Alpine packages are resolved at build time, so rebuilding
# later can change image and binary bytes even with the same base-image digest.
# Build for linux/amd64 to match the x86_64-unknown-linux-musl target.
ARG RUST_BASE
ARG ALPINE_BASE
FROM ${RUST_BASE} AS build
# `ureq` is configured with rustls (no OpenSSL link) — drop openssl-* packages.
# HTTP (not HTTPS) so the LAN apt-cacher-ng proxy can cache; integrity is
# preserved by APKINDEX signing. `id=` scopes the apk cache per base image.
RUN --mount=type=cache,id=apk-rust-1.97.1-alpine,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk musl-dev pkgconfig
WORKDIR /src
ARG PT_PRODUCER_GIT_SHA=unknown
ENV PT_PRODUCER_GIT_SHA=${PT_PRODUCER_GIT_SHA}
# `rustup target add` is a no-op on rust:1.97.1-alpine (musl is the native
# target) — kept explicit so a base-image swap to a non-musl base still works.
RUN rustup target add x86_64-unknown-linux-musl
# CARGO_INCREMENTAL=0 protects the reproducibility commitment (see header):
# the /src/target cache mount could otherwise let two builds at the same git
# SHA reuse different fingerprinted artifacts and produce different binary
# bytes (codegen-unit ordering, ThinLTO partition shifts). Full release
# rebuilds keep the byte-equality story honest; the dep-compile win still
# comes from the cached /usr/local/cargo/registry mount.
ENV CARGO_INCREMENTAL=0
ARG PT_PRODUCER_VARIANT=csv-mmap
ENV PT_PRODUCER_VARIANT=${PT_PRODUCER_VARIANT}
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# `--no-default-features` is mandatory: features `csv-bufwriter` and `csv-mmap` are mutually
# exclusive (a `compile_error!` in `lib.rs` enforces this). The crate's default includes `csv-mmap`,
# so a bare build with `csv-bufwriter` would enable both parser backends and refuse to compile.
# `--locked` is mandatory: Cargo.lock is the reproducibility anchor. Without it, a Cargo.toml edit
# that touches a dep version silently rewrites the lockfile during build and the build's
# git-SHA pin loses meaning. PT_PRODUCER_VARIANT stays the (mutually-exclusive) csv-backend
# selector; the current PTB emitter is unconditional, so a producer built from this image can always
# emit. Cargo registry + target are on cache mounts (not present in the final image layer), so the
# binary must be copied out to /tmp before strip — cache mounts don't persist across RUNs, and
# stripping in-place would discard the binary.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release -p pt-producer \
        --locked \
        --target x86_64-unknown-linux-musl \
        --no-default-features --features "${PT_PRODUCER_VARIANT}" && \
    cp /src/target/x86_64-unknown-linux-musl/release/pt-producer /tmp/pt-producer && \
    cp /src/target/x86_64-unknown-linux-musl/release/pt-build-transfers /tmp/pt-build-transfers && \
    strip /tmp/pt-producer /tmp/pt-build-transfers

# Stage 2: minimal runtime with wget for the harness's readiness probe
FROM ${ALPINE_BASE}
# See build stage above for the HTTP-downgrade rationale.
RUN --mount=type=cache,id=apk-alpine-3.20,target=/var/cache/apk,sharing=locked \
    sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories && \
    apk add --cache-dir=/var/cache/apk wget ca-certificates tzdata
COPY --from=build /tmp/pt-producer /usr/local/bin/
COPY --from=build /tmp/pt-build-transfers /usr/local/bin/
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/pt-producer"]
