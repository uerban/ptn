# Backend startup entrypoint & shell tests

## `pt-startup.sh` — container entrypoint

`pt-startup.sh` is the backend container's entrypoint. It runs **before** Node
boots and is responsible for the boot-time GTFS path:

- resolves `PT_DATA_ROOT` / `current.json` → the active generation's
  `bundle.ptb`, and exports `PT_BUNDLE_PATH`;
- optionally runs the Rust `pt-producer` sidecar;
- finally `exec`s `node`.

Shapes are served by pt-serve from the generation selected by its own
`current.json`; `pt-startup.sh` only resolves the PTB path for the backend and
does not carry shapes metadata between processes.

## `pt-startup.bats` — shell unit tests

`pt-startup.bats` unit-tests the entrypoint with
[bats](https://github.com/bats-core/bats-core) (Bash Automated Testing System —
a TAP test runner for shell scripts). The tests stub `node` and the producer onto
`PATH`, build fake generation dirs, run the script, and assert which env vars it
exports for the active PTB path and producer mode.

### Prerequisites (system tools, not pnpm deps)

| Tool  | macOS                     | Debian/Ubuntu              | Anywhere (Node)   |
| ----- | ------------------------- | -------------------------- | ----------------- |
| bats  | `brew install bats-core`  | `apt-get install bats`     | `npm i -g bats`   |
| jq    | `brew install jq`         | `apt-get install jq`       | —                 |

`jq` is required because the entrypoint (and therefore the tests) parse
`generation.json` with it.

### Run

From the repo root:

```bash
bats packages/backend/scripts/pt-startup.bats
```

Expected: TAP output ending with `ok N …` for every test and a `0 failures`
summary.

Run a single test (or a subset) by name substring with `-f`:

```bash
bats packages/backend/scripts/pt-startup.bats -f "PT_DATA_ROOT"
```

### Not wired into CI (yet)

This suite is **local/manual only** — it is intentionally not part of any CI
workflow at the moment. CI still exercises `pt-startup.sh` *indirectly*: the
`pt-serve-gate` and `memory-gate` jobs boot the backend container through this
entrypoint in PTB mode across every city, so a script that fails to boot is
caught there. Run the bats suite locally when you change `pt-startup.sh`.
