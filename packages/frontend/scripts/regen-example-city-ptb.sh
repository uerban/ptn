#!/usr/bin/env bash
# Regenerates the committed example-city.ptb fixture end to end: the GTFS feed is
# generated from scripts/fixtures/generate-example-city-gtfs.py (nothing about the
# feed is committed except that generator), then the repo's own producer turns it
# into the bundle. Deterministic: the generated zip is byte-stable, and the
# producer run pins --anchor-date and --city-tz-iana, with
# --idle-after-ingestion 0 (no idle). MUST build with the repo-pinned Rust
# toolchain (rust-toolchain.toml) so the bytes match the CI regen guard.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/packages/frontend/tests/services/__fixtures__/example-city.ptb"
# Scratch dir for the intermediate feed. The zip is an intermediate, not an
# artifact: it is reproducible from the generator, so it is never committed.
WORK="$ROOT/.example-city-build"
cd "$ROOT"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

python3 "$ROOT/scripts/fixtures/generate-example-city-gtfs.py" "$WORK/example-city.zip"

cargo build -p pt-producer --release --no-default-features --features csv-mmap --locked
"$ROOT/target/release/pt-producer" \
  --gtfs-path "$WORK/example-city.zip" \
  --out "$OUT" \
  --idle-after-ingestion 0 \
  --anchor-date 20260601 \
  --city-tz-iana UTC \
  --listen-addr 127.0.0.1:0
# --listen-addr 127.0.0.1:0 keeps the producer's readiness server on an
# ephemeral loopback port; the default 0.0.0.0:3000 collides with a running dev
# server. It does not affect the emitted bytes.
# The producer also writes *.meta.json / *.shapes.json sidecars (the loadFromPtb
# bridge needs them at runtime; the tests that read this fixture do NOT).
# meta.json embeds the producer's git SHA, so committing it would be
# non-deterministic. The committed fixture is the .ptb alone — drop the sidecars.
rm -f "$OUT.meta.json" "$OUT.shapes.json"
echo "regenerated packages/frontend/tests/services/__fixtures__/example-city.ptb (sidecars dropped)"
