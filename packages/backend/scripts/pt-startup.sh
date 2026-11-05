#!/bin/sh
# Pre-start sidecar: run the Rust GTFS ingester to disk, then exec Node.
# Failure of the Rust ingest is a hard exit — caught by the existing
# /api/health/ready healthcheck the harness polls.
#
# Pre-conditions (one of three boot modes):
#   1. PT_DATA_ROOT set: read `current.json` from the producer-published
#      data root, resolve the generation bundle, export PT_BUNDLE_PATH.
#      This is the P4 cutover path (vilnius + the 5 cities migrated by
#      the staging cities p4 migration notes).
#      Implementation below at line ~33; falls through cleanly if
#      current.json is absent/empty, citySlug mismatches CITY_ID, or the
#      resolved bundle is missing/0-byte.
#   2. GTFS_STATIC_URL set + remote URL(s): the URL list is passed through
#      to the producer (e.g. Krakow's 3-feed input).
#   3. GTFS_STATIC_URL set + local `file://...` CSV(s): bypass the producer
#      and fall back to the Node GTFS path (the producer's local mode is
#      single-path; comma-separated `file://` URLs aren't supported).
#
#   - /var/lib/ptn must be writable. Today the backend image runs as
#     root, so the mkdir succeeds. If a future hardening pass adds
#     USER node, this script needs an explicit chown or pre-created
#     /var/lib/ptn with mode 0775 in the Dockerfile.
# `set -o pipefail` is intentionally NOT used: it is a bash/busybox-ash
# extension, not POSIX `sh`, and a strict `/bin/sh` (dash) aborts on it. The
# empty/truncated-bundle case it was meant to catch is handled explicitly by
# the `[ -s ... ]` guard below, which is portable and fails at the obvious
# boot step instead of deep inside the Node loader.
set -eu

# PT_DATA_ROOT resolution: when set and `current.json` is present, parse the
# producer-published generation pointer and export PT_BUNDLE_PATH at the
# resolved generations/<gen-id>/bundle.ptb path. This bridges the producer's
# atomic-publish manifest (a pointer file, NOT a directory symlink) to the
# backend's `existsSync(ptnBundlePath)` + `loadFromPtb(ptnBundlePath, ...)`
# at packages/backend/src/gtfs/scheduler.ts:240 (which takes a literal file
# path, not a manifest). See the staging-cities migration for the
# rationale + manifest format. Must run BEFORE the legacy PT_BUNDLE_PATH
# defaulting below so a successful resolution wins over the default, but
# operators who set PT_BUNDLE_PATH directly (legacy path) are unaffected
# because PT_DATA_ROOT is unset in that mode.
PT_BUNDLE_FROM_DATA_ROOT=0
if [ -n "${PT_DATA_ROOT:-}" ] && [ -f "${PT_DATA_ROOT}/current.json" ]; then
    # Parse generationId and citySlug in a single jq invocation: halves
    # the TOCTOU window (producer may flip current.json between reads if
    # we did two passes) AND lets us capture jq's exit status so a
    # malformed/truncated current.json (e.g. partial atomic-rename) is
    # distinguishable from "valid JSON, field absent". Output is
    # newline-separated: line 1 = gen_id, line 2 = manifest_city.
    #
    # generationId is content-addressed sha256 from the producer
    # (refresh.rs:228-239 emits hex(sha256) over the canonical input).
    # Whitelist `^[a-f0-9]{64}$` — exactly 64 hex chars, matching the
    # writer's exact output. Anything else is rejected (non-string types,
    # path-escape attempts like `../../../etc/passwd`, truncated/short
    # SHAs that could resolve outside the data root).
    # `if cmd; then ... else ... fi` form (not `var=$(cmd); check $?`) so
    # `set -e` doesn't exit on the failed-jq case — we want fallthrough,
    # not boot failure, when current.json is malformed.
    if manifest_fields=$(jq -r '
        (if (.generationId | type) == "string" and (.generationId | test("^[a-f0-9]{64}$"))
            then .generationId else "" end),
        (.citySlug // "" | gsub("^\\s+|\\s+$"; ""))
    ' < "${PT_DATA_ROOT}/current.json" 2>/dev/null); then
        gen_id=$(printf '%s\n' "${manifest_fields}" | sed -n '1p')
        manifest_city=$(printf '%s\n' "${manifest_fields}" | sed -n '2p')
    else
        echo "[pt-startup] PT_DATA_ROOT=${PT_DATA_ROOT} current.json failed to parse (malformed/truncated JSON, possibly mid-publish race); falling through" >&2
        gen_id=""
        manifest_city=""
    fi
    # Cross-check the manifest's citySlug against the operator-supplied CITY_ID
    # env. A swapped volume (e.g. pt-serve-paris-data mounted into
    # backend-krakow) would otherwise silently serve wrong-city data — the
    # X-PT-Expected-City header only catches misroutes at the nginx hop, not
    # bundle-level drift inside the same container. pt-serve has the same
    # guard at crates/pt-serve/src/bundle/loader.rs; this mirrors it on the
    # Node side at the boot step.
    #
    # If manifest_city is set but CITY_ID is unset, we cannot verify — log a
    # loud warning and fall through to legacy (avoids fail-open silent
    # wrong-city load). If both are set and differ, fail closed.
    if [ -n "${manifest_city}" ]; then
        if [ -z "${CITY_ID:-}" ]; then
            echo "[pt-startup] PT_DATA_ROOT=${PT_DATA_ROOT} current.json declares citySlug=${manifest_city} but CITY_ID is unset; cannot verify — falling through to legacy" >&2
            gen_id=""
        elif [ "${manifest_city}" != "${CITY_ID}" ]; then
            echo "[pt-startup] PT_DATA_ROOT=${PT_DATA_ROOT} current.json citySlug=${manifest_city} but CITY_ID=${CITY_ID} — refusing to load wrong-city bundle" >&2
            exit 1
        fi
    fi
    if [ -n "${gen_id}" ]; then
        resolved="${PT_DATA_ROOT}/generations/${gen_id}/bundle.ptb"
        # `-s` (non-empty) not `-f` (exists) — a half-written bundle.ptb (e.g.
        # producer crashed mid-publish before fsync) is a 0-byte file that
        # passes `-f` but blows up deep inside loadFromPtb with "buffer too
        # small for header". Match the post-producer gate's own `-s` check at
        # line 118 below.
        if [ -s "${resolved}" ]; then
            export PT_BUNDLE_PATH="${resolved}"
            PT_BUNDLE_FROM_DATA_ROOT=1
            echo "[pt-startup] resolved PT_DATA_ROOT=${PT_DATA_ROOT} generationId=${gen_id} -> PT_BUNDLE_PATH=${PT_BUNDLE_PATH}" >&2
        else
            echo "[pt-startup] PT_DATA_ROOT=${PT_DATA_ROOT} current.json references generationId=${gen_id} but bundle.ptb is missing or empty; falling through" >&2
        fi
    else
        echo "[pt-startup] PT_DATA_ROOT=${PT_DATA_ROOT} current.json missing or invalid generationId; falling through" >&2
    fi
fi

PT_BUNDLE_DIR="${PT_BUNDLE_DIR:-/var/lib/ptn}"
PT_BUNDLE_PATH="${PT_BUNDLE_PATH:-${PT_BUNDLE_DIR}/bundle.ptb}"
# Create the parent of the *actual* bundle path, not just PT_BUNDLE_DIR:
# an operator can set PT_BUNDLE_PATH to a directory that PT_BUNDLE_DIR
# doesn't cover (both are independent, operator-settable env vars per
# .env.example), and the producer write would otherwise fail on a missing dir.
mkdir -p "$(dirname "${PT_BUNDLE_PATH}")"

exec_node_direct() {
    # The legacy Node-only fallback unsets PT_BUNDLE_PATH because no producer
    # write has happened. But when PT_DATA_ROOT resolved a bundle, that
    # path IS the bundle Node should consume — preserve it.
    if [ "${PT_BUNDLE_FROM_DATA_ROOT}" != "1" ]; then
        unset PT_BUNDLE_PATH
    fi
    exec node packages/backend/dist/index.js
}

if [ -z "${GTFS_STATIC_URL:-}" ]; then
    echo "[pt-startup] GTFS_STATIC_URL not set; falling back to Node-only GTFS path" >&2
    exec_node_direct
fi

if [ "${PT_DISABLE_PRODUCER:-0}" = "1" ]; then
    case "${GTFS_STATIC_URL}" in
        *file://*) export PT_ALLOW_FILE_URLS=1 ;;
    esac
    echo "[pt-startup] PT_DISABLE_PRODUCER=1; skipping producer and starting Node GTFS path" >&2
    exec_node_direct
fi

case "${GTFS_STATIC_URL}" in
    file://*,file://*)
        echo "[pt-startup] multiple local GTFS snapshots bypass the producer; starting Node GTFS path directly" >&2
        export PT_ALLOW_FILE_URLS=1
        exec_node_direct
        ;;
esac

case "${GTFS_STATIC_URL}" in
    *file://*) export PT_ALLOW_FILE_URLS=1 ;;
esac

if [ "${GTFS_STATIC_URL#file://}" != "${GTFS_STATIC_URL}" ]; then
    # The producer accepts local snapshots via --gtfs-path, not via --gtfs-url.
    GTFS_LOCAL_PATH="${GTFS_STATIC_URL#file://}"
    echo "[pt-startup] running pt-producer --gtfs-path ${GTFS_LOCAL_PATH} → ${PT_BUNDLE_PATH} (PTB v1)" >&2
    pt-producer \
        --gtfs-path "${GTFS_LOCAL_PATH}" \
        --out "${PT_BUNDLE_PATH}" \
        --idle-after-ingestion 0
else
    echo "[pt-startup] running pt-producer → ${PT_BUNDLE_PATH} (PTB v1)" >&2
    pt-producer \
        --gtfs-url "${GTFS_STATIC_URL}" \
        --out "${PT_BUNDLE_PATH}" \
        --idle-after-ingestion 0
fi

# The producer persists the bundle + sidecars before exiting, so there is no
# steady-state window to wait for here: `--idle-after-ingestion 0` makes the
# producer exit immediately after the write, keeping the extra second off the
# cold-start path this sidecar exists to shrink.

# Producer exited 0, but a truncated/zero-byte bundle would still let `exec node`
# proceed and then fail deep inside the loader ("buffer too small for header").
# Gate on a non-empty file so the failure surfaces here at the obvious step.
if [ ! -s "${PT_BUNDLE_PATH}" ]; then
    echo "[pt-startup] producer exited 0 but bundle is missing or empty: ${PT_BUNDLE_PATH}" >&2
    exit 1
fi

# Hand off to Node with the bundle path exported.
# `wc -c < FILE` is POSIX-portable (Alpine's busybox supports it);
# `stat -c %s` is GNU-only and rejected by busybox.
BUNDLE_BYTES=$(wc -c < "${PT_BUNDLE_PATH}" | tr -d ' ')
export PT_BUNDLE_PATH
echo "[pt-startup] bundle ready (${BUNDLE_BYTES} bytes); exec'ing node" >&2
exec node packages/backend/dist/index.js
