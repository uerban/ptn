<!--
Release notes template. The draft workflow (scripts/prepare-release-draft.py)
renders it into every new draft titled "PTN vX.Y.N": it fills the version,
tag, previous release, validation runs and merged pull requests, and removes
these comments. Before promotion, edit the draft and replace the remaining
placeholders: {{SUMMARY}}, {{CHANGES}} and {{UPGRADING}}. Promotion refuses
notes that still contain a placeholder.

- {{SUMMARY}}: one sentence after "PTN X.Y.N", user-facing.
- {{CHANGES}}: bullets for what users and self-hosters notice, grouped by
  theme, each with its effect. Use the pull request list as the source. Only
  changes in the tagged commit compared with the previous release.
- {{UPGRADING}}: required steps, migrations or compatibility notes. Delete the
  whole section when there are none.

Verify every claim against the tagged source and the successful runs. Keep
limitations specific to what was actually tested.
-->
PTN {{VERSION}} {{SUMMARY}}

## Changes

{{CHANGES}}

## Downloads and hosting

Choose the archive matching your operating system and architecture:

| Platform | Archive |
|---|---|
| Linux x86_64 | `ptn-linux-x86_64.tar.gz` |
| Linux ARMv6 hard-float, including Raspberry Pi 1/Zero | `ptn-linux-armv6-rpi1.tar.gz` |
| Linux AArch64, including Raspberry Pi 3+ with a 64-bit OS | `ptn-linux-aarch64-rpi3.tar.gz` |
| macOS Apple Silicon | `ptn-darwin-arm64.tar.gz` |
| macOS Intel | `ptn-darwin-x86_64.tar.gz` |

Each archive includes six native tools, matching PWA assets, a local OSM builder,
licenses, hosting instructions, and internal checksums. Each download also has
an accompanying `.sha256` file. No Rust compiler or source checkout is needed
to use the prebuilt tools. City data is installed separately.

See the [native hosting guide](https://github.com/uerban/ptn/blob/{{TAG}}/examples/native/README.md),
[Docker hosting guide](https://github.com/uerban/ptn/blob/{{TAG}}/docker/README.md),
and [platform details](https://github.com/uerban/ptn/blob/{{TAG}}/docs/release-platforms.md)
for setup, compatibility, and prerequisites.

## Upgrading

{{UPGRADING}}

## Validation

[Validation run]({{VALIDATION_RUN_URL}}) passed for source commit
[`{{SHORT_SHA}}`](https://github.com/uerban/ptn/commit/{{SOURCE_SHA}}).

The run built and tested the release, ran secret and dependency security scans,
packaged all five archives, smoke-tested the ARM and macOS builds, and validated
native and Docker hosting on a fresh Linux x86_64 host, including that the
served version matches each archive. The [regression gates]({{REGRESSION_RUN_URL}})
for performance, memory and routing parity passed on the same commit.

ARM execution smoke checks use QEMU; this does not prove real-device memory
capacity or performance. Full Linux x86_64 hosting checks do not establish full
hosting validation on ARM or macOS.

Archives are promoted unchanged: `release-evidence.json` records the source
commit, run IDs and SHA-256 of every archive.

## Pull requests

{{PULL_REQUESTS}}

[Changes since {{PREVIOUS_TAG}}](https://github.com/uerban/ptn/compare/{{PREVIOUS_TAG}}...{{TAG}}).
