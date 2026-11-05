# syntax=docker/dockerfile:1.7
# Build the initial supported release on Linux x86_64 (native or emulated).
FROM docker.io/library/rust:1.97.1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/backend/src/health/feedStaleConstants.ts ./packages/backend/src/health/feedStaleConstants.ts
COPY packages/shared/src/constants/defaults.ts ./packages/shared/src/constants/defaults.ts
COPY packages/shared/src/poi/tileParams.ts ./packages/shared/src/poi/tileParams.ts
ENV CARGO_INCREMENTAL=0
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p pt-serve -p pt-producer -p pt-artifacts -p pt-walk --features pt-walk/build && \
    mkdir /out && cp target/release/pt-serve target/release/pt-producer \
      target/release/pt-build-transfers target/release/pt-artifacts \
      target/release/pt-walk-build target/release/pt-artifact-publish /out/
FROM scratch AS binaries
COPY --from=build /out/ /
