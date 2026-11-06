# syntax=docker/dockerfile:1.7
# Downloading deployments contain only the manager, never generation tools/data.
ARG RUST_BASE=rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900
FROM ${RUST_BASE} AS builder
RUN apk add --no-cache musl-dev ca-certificates
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
ENV CARGO_INCREMENTAL=0
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build -p pt-artifacts --release --locked && \
    cp target/release/pt-artifacts /tmp/pt-artifacts && strip /tmp/pt-artifacts && \
    cp target/release/pt-transit /tmp/pt-transit && strip /tmp/pt-transit

# Build with --target transit for the independent transit installer.
FROM scratch AS transit
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /tmp/pt-transit /pt-transit
ENTRYPOINT ["/pt-transit"]

# Keep the existing default image/entrypoint for OSM consumers.
FROM scratch AS artifacts
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /tmp/pt-artifacts /pt-artifacts
ENTRYPOINT ["/pt-artifacts"]
