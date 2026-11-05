# pt-producer

Rust GTFS producer for PTN. It parses one or more GTFS Schedule feeds, emits
PTB routing bundles and generation sidecars, validates the complete generation,
and atomically publishes it for `pt-serve`.

The crate is a member of the root Cargo workspace and provides two binaries:

- `pt-producer` — one-shot bundle build, periodic generation publisher, and
  disaster-recovery republisher.
- `pt-build-transfers` — offline Dijkstra builder for PTFT pedestrian transfer
  tables. Query-time pedestrian routing remains out of scope.

## Build and test

From the repository root:

```bash
cargo build -p pt-producer --locked
cargo test -p pt-producer --locked
```

The production default enables the `csv-mmap` parser/writer and modern PTB
emission. The retained parser measurement variants are mutually exclusive:

```bash
cargo test -p pt-producer --locked --no-default-features \
  --features csv-bufwriter
cargo test -p pt-producer --locked --no-default-features \
  --features hand-rolled
```

## Producer commands

Build a bundle from a local feed:

```bash
cargo run -p pt-producer --bin pt-producer -- \
  --gtfs-path crates/pt-producer/tests/fixtures/tiny-gtfs.zip \
  --out /tmp/tiny.ptb \
  --idle-after-ingestion 0
```

Run the long-lived publisher:

```bash
pt-producer periodic-refresh \
  --data-root /var/lib/pt-vilnius \
  --city vilnius \
  --city-tz-iana Europe/Vilnius \
  --gtfs /opt/gtfs/vilnius.zip
```

Build a transfer table from a pre-built walking graph and stops JSON:

```bash
pt-build-transfers \
  --city vilnius \
  --stops /opt/gtfs/vilnius-stops.json \
  --walking-graph-dir /opt/walking/vilnius \
  --out-dir /var/lib/pt-transfers/vilnius
```

## Health and metrics

The one-shot compatibility mode exposes `/api/health/live` and
`/api/health/ready` on `--listen-addr`. `periodic-refresh` optionally exposes
`/healthz`, `/readyz`, and `/metrics` through
`--liveness-listen-addr`. Producer metrics retain their existing
`producer_*`/`pt_producer_*` names.

## Container image

The standalone Dockerfile uses the repository root as its build context and
installs both binaries:

```bash
docker build --platform=linux/amd64 \
  -f crates/pt-producer/Dockerfile \
  --build-arg RUST_BASE="rust:1.97.1-alpine@sha256:<digest>" \
  --build-arg ALPINE_BASE="alpine:3.20@sha256:<digest>" \
  --build-arg PT_PRODUCER_GIT_SHA="$(git rev-parse HEAD)" \
  -t pt-producer:local .
```

The backend production image also installs both binaries because Compose uses
that image for the producer sidecars.
