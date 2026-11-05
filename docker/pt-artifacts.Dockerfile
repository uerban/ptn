# syntax=docker/dockerfile:1.7
# Downloading deployments contain only the manager, never generation tools/data.
ARG RUST_BASE=rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900
FROM ${RUST_BASE} AS builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
ENV CARGO_INCREMENTAL=0
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build -p pt-artifacts --release --locked && \
    cp target/release/pt-artifacts /tmp/pt-artifacts && strip /tmp/pt-artifacts

FROM scratch
COPY --from=builder /tmp/pt-artifacts /pt-artifacts
ENTRYPOINT ["/pt-artifacts"]
