#!/usr/bin/env bats

# Tests for pt-startup.sh. The script under test calls `pt-producer` (via
# PATH, not the absolute /usr/local/bin path, so the stub here can intercept)
# and `node` (also via PATH). We stub both into BATS_TEST_TMPDIR/stubs/ and
# prepend that directory onto PATH.

SCRIPT="${BATS_TEST_DIRNAME}/pt-startup.sh"

setup() {
  PT_BUNDLE_DIR="$(mktemp -d)"
  export PT_BUNDLE_DIR
  export PT_BUNDLE_PATH="${PT_BUNDLE_DIR}/bundle.ptb"

  mkdir -p "${BATS_TEST_TMPDIR}/stubs"
  export PATH="${BATS_TEST_TMPDIR}/stubs:${PATH}"

  # Default producer stub: write the v4 PTB\0 magic to --out and exit 0.
  cat > "${BATS_TEST_TMPDIR}/stubs/pt-producer" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; printf 'PTB\0' > "$1"; shift ;;
    *) shift ;;
  esac
done
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/pt-producer"

  # Stub node: echo a marker line so we can confirm exec happened and
  # whether PT_BUNDLE_PATH was visible to Node's env.
  cat > "${BATS_TEST_TMPDIR}/stubs/node" <<'EOF'
#!/bin/sh
echo "NODE_EXECED:${PT_BUNDLE_PATH:-unset}"
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/node"
}

teardown() {
  rm -rf "${PT_BUNDLE_DIR}"
}

@test "GTFS_STATIC_URL unset → Node-only path; PT_BUNDLE_PATH unset in Node's env" {
  unset GTFS_STATIC_URL
  run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "GTFS_STATIC_URL set → producer runs → Node sees PT_BUNDLE_PATH" {
  GTFS_STATIC_URL="http://example/feed.zip" run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NODE_EXECED:${PT_BUNDLE_PATH}"* ]]
}

@test "GTFS_STATIC_URL=file://... → producer uses --gtfs-path local zip" {
  local zip_path="${BATS_TEST_TMPDIR}/fixture.gtfs.zip"
  : > "${zip_path}"

  cat > "${BATS_TEST_TMPDIR}/stubs/pt-producer" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "${BATS_TEST_TMPDIR}/producer-args.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; printf 'PTB\0' > "$1"; shift ;;
    *) shift ;;
  esac
done
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/pt-producer"

  GTFS_STATIC_URL="file://${zip_path}" run "${SCRIPT}"
  [ "$status" -eq 0 ]
  run cat "${BATS_TEST_TMPDIR}/producer-args.txt"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--gtfs-path ${zip_path}"* ]]
  [[ "$output" != *"--gtfs-url file://${zip_path}"* ]]
}

@test "PT_DISABLE_PRODUCER=1 → Node-only path even when GTFS_STATIC_URL is set" {
  cat > "${BATS_TEST_TMPDIR}/stubs/pt-producer" <<'EOF'
#!/bin/sh
exit 99
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/pt-producer"

  PT_DISABLE_PRODUCER=1 GTFS_STATIC_URL="http://example/feed.zip" run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "GTFS_STATIC_URL=file://...,file://... → falls back to Node direct path" {
  local zip_a="${BATS_TEST_TMPDIR}/fixture-a.gtfs.zip"
  local zip_b="${BATS_TEST_TMPDIR}/fixture-b.gtfs.zip"
  : > "${zip_a}"
  : > "${zip_b}"

  cat > "${BATS_TEST_TMPDIR}/stubs/pt-producer" <<'EOF'
#!/bin/sh
exit 99
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/pt-producer"

  cat > "${BATS_TEST_TMPDIR}/stubs/node" <<'EOF'
#!/bin/sh
echo "NODE_EXECED:${PT_BUNDLE_PATH:-unset}:${PT_ALLOW_FILE_URLS:-unset}"
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/node"

  GTFS_STATIC_URL="file://${zip_a},file://${zip_b}" run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NODE_EXECED:unset:1"* ]]
}

@test "producer exit non-zero → script exits non-zero (set -eu)" {
  cat > "${BATS_TEST_TMPDIR}/stubs/pt-producer" <<'EOF'
#!/bin/sh
exit 7
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/pt-producer"
  GTFS_STATIC_URL="http://example/feed.zip" run "${SCRIPT}"
  [ "$status" -eq 7 ]
}

@test "producer exits 0 but bundle is empty → script aborts before exec'ing node" {
  # Producer stub that creates an empty --out file and exits 0 (truncated write).
  cat > "${BATS_TEST_TMPDIR}/stubs/pt-producer" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; : > "$1"; shift ;;
    *) shift ;;
  esac
done
EOF
  chmod +x "${BATS_TEST_TMPDIR}/stubs/pt-producer"
  GTFS_STATIC_URL="http://example/feed.zip" run "${SCRIPT}"
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing or empty"* ]]
  [[ "$output" != *"NODE_EXECED"* ]]
}

@test "PT_DATA_ROOT resolves current.json → generation bundle.ptb reaches Node" {
  # Producer-published layout: <data-root>/generations/<sha>/bundle.ptb +
  # <data-root>/current.json pointer manifest.
  data_root="${BATS_TEST_TMPDIR}/data-root"
  # Realistic sha256 shape (64 hex chars); the script's regex guard accepts
  # 16..128 chars from [a-f0-9] (refresh.rs writes hex(sha256)).
  gen_id="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  mkdir -p "${data_root}/generations/${gen_id}"
  printf 'PTB\0' > "${data_root}/generations/${gen_id}/bundle.ptb"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "${gen_id}", "citySlug": "vilnius", "createdAt": "2026-05-25T10:00:00Z" }
EOF

  # Drop the setup()-provided default PT_BUNDLE_PATH so we exercise resolution
  # from PT_DATA_ROOT exclusively (legacy + resolved precedence is asserted
  # by the existing tests above).
  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NODE_EXECED:${data_root}/generations/${gen_id}/bundle.ptb"* ]]
  [[ "$output" == *"resolved PT_DATA_ROOT="* ]]
}

@test "PT_DATA_ROOT with missing current.json leaves PT_BUNDLE_PATH unresolved" {
  data_root="${BATS_TEST_TMPDIR}/data-root-empty"
  mkdir -p "${data_root}"

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 run "${SCRIPT}"
  [ "$status" -eq 0 ]
  # Node sees no PT_BUNDLE_PATH because exec_node_direct unsets it when no
  # resolution happened — matches the legacy Node-only fallback behavior.
  [[ "$output" == *"NODE_EXECED:unset"* ]]
  [[ "$output" != *"resolved PT_DATA_ROOT="* ]]
}

@test "PT_DATA_ROOT with current.json but missing generation bundle warns and falls through" {
  data_root="${BATS_TEST_TMPDIR}/data-root-no-bundle"
  # Realistic sha shape; passes the regex guard but the file is absent.
  gen_id="0000000000000000000000000000000000000000000000000000000000000001"
  mkdir -p "${data_root}"
  # current.json points to a generationId whose bundle.ptb is absent.
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "${gen_id}", "citySlug": "vilnius", "createdAt": "2026-05-25T10:00:00Z" }
EOF

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"bundle.ptb is missing or empty"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "PT_DATA_ROOT with empty (0-byte) bundle.ptb falls through (catches half-written publish)" {
  # Producer-crashed-mid-publish scenario: current.json was renamed
  # atomically but the bundle.ptb's fsync didn't complete before crash.
  # `-s` (non-empty) gate catches it at the boot step rather than letting
  # loadFromPtb fail deep inside the loader with "buffer too small for header".
  data_root="${BATS_TEST_TMPDIR}/data-root-empty-bundle"
  gen_id="0000000000000000000000000000000000000000000000000000000000000002"
  mkdir -p "${data_root}/generations/${gen_id}"
  # Touch a 0-byte file — passes `-f` but not `-s`.
  : > "${data_root}/generations/${gen_id}/bundle.ptb"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "${gen_id}", "citySlug": "vilnius", "createdAt": "2026-05-25T10:00:00Z" }
EOF

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"bundle.ptb is missing or empty"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "PT_DATA_ROOT with citySlug mismatch refuses to load" {
  # Defense-in-depth: a swapped volume (pt-serve-paris-data mounted into
  # backend-krakow by operator error) must not silently serve wrong-city
  # data. pt-serve has the equivalent guard in
  # crates/pt-serve/src/bundle/loader.rs; mirroring here on the Node side.
  data_root="${BATS_TEST_TMPDIR}/data-root-wrong-city"
  gen_id="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  mkdir -p "${data_root}/generations/${gen_id}"
  printf 'PTB\0' > "${data_root}/generations/${gen_id}/bundle.ptb"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "${gen_id}", "citySlug": "paris", "createdAt": "2026-05-25T10:00:00Z" }
EOF

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=krakow run "${SCRIPT}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"citySlug=paris but CITY_ID=krakow"* ]]
  [[ "$output" == *"refusing to load wrong-city bundle"* ]]
}

@test "PT_DATA_ROOT with non-string generationId is rejected by the regex guard" {
  # A malformed current.json with generationId as an integer (e.g. 42)
  # would historically pass through jq -r as the string "42" and resolve
  # generations/42/bundle.ptb. The regex guard now rejects non-hex content
  # so the script falls into the "missing or invalid generationId" branch.
  data_root="${BATS_TEST_TMPDIR}/data-root-int-gen"
  mkdir -p "${data_root}"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": 42, "citySlug": "vilnius" }
EOF

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"missing or invalid generationId"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "PT_DATA_ROOT with corrupt/truncated current.json logs distinct error and falls through" {
  # Producer crash mid-atomic-write produces a half-flushed current.json.
  # The previous code silenced jq parse errors with `2>/dev/null || true`
  # so corruption was indistinguishable from "valid JSON, field absent".
  # Now: distinct "failed to parse" log line, no silent fallthrough.
  data_root="${BATS_TEST_TMPDIR}/data-root-corrupt"
  mkdir -p "${data_root}"
  # Truncated JSON: opens an object but never closes it.
  printf '{ "manifestSchemaVersion": 1, "generationId": "abc' > "${data_root}/current.json"

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"failed to parse"* ]]
  [[ "$output" != *"missing or invalid generationId"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "PT_DATA_ROOT with manifest citySlug but CITY_ID unset warns and falls through" {
  # Operator misconfig: PT_DATA_ROOT wired but CITY_ID forgotten in compose.
  # Previously the citySlug guard silently short-circuited (fall-open
  # wrong-city load risk); now we log a loud warning and fall through to
  # legacy rather than blindly trusting the manifest.
  data_root="${BATS_TEST_TMPDIR}/data-root-no-city-id"
  gen_id="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  mkdir -p "${data_root}/generations/${gen_id}"
  printf 'PTB\0' > "${data_root}/generations/${gen_id}/bundle.ptb"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "${gen_id}", "citySlug": "vilnius" }
EOF

  unset PT_BUNDLE_PATH
  unset CITY_ID

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CITY_ID is unset"* ]]
  [[ "$output" == *"falling through to legacy"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "PT_DATA_ROOT with truncated 32-char gen_id is rejected by tightened regex" {
  # The regex was previously [a-f0-9]{16,128} which accepted 16-char shortcuts;
  # tightened to exactly 64 chars (SHA-256). A truncated SHA must now be
  # rejected at the loader rather than resolving generations/<short-sha>/...
  data_root="${BATS_TEST_TMPDIR}/data-root-short-sha"
  short_gen_id="abcdef0123456789abcdef0123456789"  # 32 chars
  mkdir -p "${data_root}"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "${short_gen_id}", "citySlug": "vilnius" }
EOF

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"missing or invalid generationId"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}

@test "PT_DATA_ROOT with path-escape generationId is rejected by the regex guard" {
  # Defense-in-depth against operator/tooling errors that put a literal
  # path-escape string into generationId. The regex restricts to [a-f0-9]
  # so any `/` or `.` is rejected outright.
  data_root="${BATS_TEST_TMPDIR}/data-root-pathesc"
  mkdir -p "${data_root}"
  cat > "${data_root}/current.json" <<EOF
{ "manifestSchemaVersion": 1, "generationId": "../../../etc/passwd", "citySlug": "vilnius" }
EOF

  unset PT_BUNDLE_PATH

  PT_DATA_ROOT="${data_root}" PT_DISABLE_PRODUCER=1 CITY_ID=vilnius run "${SCRIPT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"missing or invalid generationId"* ]]
  [[ "$output" == *"NODE_EXECED:unset"* ]]
}
