#!/usr/bin/env bash
# Rebuild catalog.ptb and catalog-shapeless.ptb from raptor-data.json as PTB v2
# with the Rust producer's v2 stager. CI runs this and fails on a diff.
#
#   cargo build --release -p pt-producer --bin pt-ptb-v2-stage
#   packages/frontend/e2e/fixtures/regen-catalog-ptb.sh
#
# The feed runs every day from 2026-01-01. The stager shifts the anchor back
# GUARD_DAYS (2), so anchor 20260103 gives a window that starts on the feed's
# first day, so every day is in service. Its service-day origins are fixed, so
# the bytes need no re-anchoring: the harness uses them as built.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
FIX="$ROOT/packages/frontend/e2e/fixtures"
STAGE="${PT_PTB_V2_STAGE:-$ROOT/target/release/pt-ptb-v2-stage}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for variant in catalog catalog-shapeless; do
  flag=""
  if [ "$variant" = catalog-shapeless ]; then flag="--shapeless"; fi
  node "$FIX/catalog-gtfs.mjs" "$WORK/$variant" $flag
  (cd "$WORK/$variant" && zip -X -q "../$variant.zip" ./*.txt)
  "$STAGE" --gtfs "$WORK/$variant.zip" --timezone Europe/Vilnius \
    --anchor-date 20260103 --out-dir "$WORK/$variant-v2" >/dev/null 2>&1
  cp "$WORK/$variant-v2/bundle.ptb" "$FIX/$variant.ptb"
done
