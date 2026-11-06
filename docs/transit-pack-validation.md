# Validate a retained city through installation and offline serving

Run this harness from a source checkout or matching release archive on a builder with native tools,
Python 3.9+ and an OpenSSL executable supporting Ed25519. Select a generation
whose feed provenance and publication rights have already been reviewed. The
harness validates its bytes; it does not establish those approvals.

```sh
python3 scripts/verify-transit-installation.py \
  --generation /absolute/accepted/generation \
  --bin-dir /absolute/matching/binaries \
  --work-directory /absolute/new/private-check-directory \
  --plan-request /absolute/accepted/plan-request.json
```

The working directory must not exist. Its parent must exist. The harness creates
it with private permissions, keeps exports, an isolated test repository, consumer
state and server logs, and prints the final `evidence.json` path only on success.
It generates ephemeral test signing keys and removes the private key files after
publication, including on publication failure. Never use the resulting repository
as a production publication. Only caller-selected inputs and local directories
are used; no live feed downloads or production changes occur.

Use `--openssl /path/to/openssl` if the default executable lacks Ed25519 support,
as can happen with the system LibreSSL on macOS. The check needs permission to
bind three temporary loopback listeners. It starts only its own server process
and terminates it after each probe.

The harness:

- Natively validates and exports geometry-free and full selections of one pack.
- Publishes a signed city catalog and signed served-city discovery to an isolated
  repository, then installs each variant through discovery.
- Makes that repository unavailable during offline revalidation and startup.
- Compares HTTP PTB, PTFT (when present) and every advertised schedule tile with
  their source inventory hashes. It verifies full shapes when advertised and
  their intentional unavailability in minimal mode.
- Optionally requires a non-empty `/plan` result and identical canonical JSON
  across variants. Without `--plan-request`, routing is **not** checked.
- Rejects a tampered discovery document without changing city activation, rolls
  back to the retained minimal selection, verifies that rollback is pinned, and
  revalidates it offline.
- Records selected byte/file counts, checked response hashes and exact binary
  hashes. No private keys are included in evidence.

The plan request is the accepted server POST `/plan` body, for example:

```json
{
  "entryStops": [{"stopId": "ORIGIN_ID", "walkSecs": 0}],
  "exitStops": [{"stopId": "DESTINATION_ID", "walkSecs": 0}],
  "departureSecs": 32400,
  "date": "20261107"
}
```

Choose real IDs and an active service date from the selected generation. Keep
operator inputs and evidence in their private storage; do not commit feeds,
exports, keys, state or generated test repositories.

This check uses local-directory transport and a 2 GiB server admission allowance.
It does not impose a host memory limit or establish minimum RAM, startup capacity,
HTTP mirror behavior, Caddy/Cloudflare caching, frontend accessibility, independent
OSM extras, or acceptance of a current production snapshot. Run those checks
separately before exposing a public source.
