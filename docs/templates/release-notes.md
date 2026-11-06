<!--
Copy this file for a release. Replace every {{placeholder}} and remove these
instructions, unused sections, and rows for platforms not actually attached.
Describe only changes in the tagged commit compared with the previous release.
Read component versions from that commit with scripts/version.py list; do not
assume that every component shares the release tag's version.
Verify validation claims against the successful run and attached assets.
Keep limitations specific to what was actually tested. Do not include work
that exists only on unmerged branches. Edit the draft before publication.
-->

PTN {{VERSION}} {{ONE_SENTENCE_USER_FACING_SUMMARY}}.

## Changes

- {{CHANGE_AND_ITS_USER_VISIBLE_EFFECT}}
- {{FIX_AND_THE_BEHAVIOR_IT_CORRECTS}}

## Component versions

<!-- Include changed components, especially for a crate-specific hotfix. -->

| Component | Previous | Included |
|---|---|---|
| {{COMPONENT_NAME}} | {{OLD_VERSION}} | {{NEW_VERSION}} |

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

<!-- Keep this section when users must act or compatibility changes. -->

{{REQUIRED_STEPS_MIGRATIONS_OR_COMPATIBILITY_NOTES}}

## Validation

[Validation run]({{VALIDATION_RUN_URL}}) passed for source commit
[`{{SHORT_SHA}}`](https://github.com/uerban/ptn/commit/{{SOURCE_SHA}}).

{{CHECKS_THAT_ACTUALLY_PASSED_AND_THE_PLATFORMS_THEY_COVER}}

{{KNOWN_LIMITATIONS_OR_UNTESTED_HOST_SPECIFIC_BEHAVIOR}}

<!-- When applicable: ARM execution smoke checks use QEMU; this does not prove
real-device memory capacity or performance. Full Linux x86_64 hosting checks do
not establish full hosting validation on ARM or macOS. Local TLS tests do not
establish public DNS/ACME configuration. -->

[Changes since {{PREVIOUS_TAG}}](https://github.com/uerban/ptn/compare/{{PREVIOUS_TAG}}...{{TAG}}).
