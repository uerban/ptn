<!--
Release notes template. The draft workflow (scripts/prepare-release-draft.py)
renders it into every new draft titled "PTN vX.Y.N". It fills the version,
tags, validation runs and the grouped pull request list, and removes these
comments. Before promotion, edit the draft and replace or delete every
remaining placeholder; promotion refuses notes that still contain one.

- {{SUMMARY}}: the rest of the opening sentence after "PTN X.Y.N": what this
  release brings, in user terms ("adds service alerts and arrive-by trip
  planning."). Add a second sentence only for something every reader must know.
- {{ATTENTION}}: when self-hosters must act before or during the upgrade, one
  GitHub callout naming the action and pointing to Upgrading:
    > [!IMPORTANT]
    > City recipes using mirrors need schemaVersion 2; see Upgrading.
  Otherwise delete the line.
- {{RIDERS}}: what people using the app notice. {{SELF_HOSTING}}: what people
  running PTN notice (configuration, tools, data refresh, API, platforms).
  One bullet per theme, most important first:
    - **Theme.** What changed and its visible effect, in plain words. (#90, #96)
  Describe effects, not implementation. Cite the pull requests from the list
  below. Delete a section that has nothing for its audience.
- {{UPGRADING}}: concrete steps, new or changed settings, compatibility and
  migrations, each with the exact name (`PT_FEEDS_BUDGET_DIR`). Write "No
  action needed." when there is nothing to do.

Only changes in the tagged commit since the previous stable release. Verify
every claim against the tagged source and the successful runs, and keep
limitations specific to what was actually tested.
-->
PTN {{VERSION}} {{SUMMARY}}

{{ATTENTION}}

## For riders

{{RIDERS}}

## For self-hosters

{{SELF_HOSTING}}

## Upgrading

These notes cover upgrading from {{PREVIOUS_TAG}}. When skipping releases, also
read the Upgrading section of each skipped release.

{{UPGRADING}}

## Downloads

Choose the archive matching your operating system and architecture:

| Platform | Archive |
|---|---|
| Linux x86_64 | `ptn-linux-x86_64.tar.gz` |
| Linux ARMv6 hard-float, including Raspberry Pi 1/Zero | `ptn-linux-armv6-rpi1.tar.gz` |
| Linux AArch64, including Raspberry Pi 3+ with a 64-bit OS | `ptn-linux-aarch64-rpi3.tar.gz` |
| macOS Apple Silicon | `ptn-darwin-arm64.tar.gz` |
| macOS Intel | `ptn-darwin-x86_64.tar.gz` |

Each archive includes six native tools, matching PWA assets, a local OSM builder,
licenses, hosting instructions, and internal checksums. No Rust compiler or
source checkout is needed to use the prebuilt tools. City data is installed
separately.

Verify a download against its `.sha256` file before unpacking:

```sh
sha256sum -c ptn-linux-x86_64.tar.gz.sha256      # Linux
shasum -a 256 -c ptn-darwin-arm64.tar.gz.sha256  # macOS
```

See the [native hosting guide](https://github.com/uerban/ptn/blob/{{TAG}}/examples/native/README.md),
[Docker hosting guide](https://github.com/uerban/ptn/blob/{{TAG}}/docker/README.md),
and [platform details](https://github.com/uerban/ptn/blob/{{TAG}}/docs/release-platforms.md)
for setup, compatibility, and prerequisites.

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
