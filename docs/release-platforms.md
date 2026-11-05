# Release platforms

The release workflow packages these targets from one source revision. Each
archive contains six native tools, matching PWA assets, the local OSM builder,
hosting instructions, and checksums.

| Archive platform | Rust target | Intended native host |
|---|---|---|
| `linux-x86_64` | `x86_64-unknown-linux-musl` | 64-bit Intel/AMD Linux |
| `linux-armv6-rpi1` | `arm-unknown-linux-musleabihf` | Raspberry Pi 1/Zero with a 32-bit hard-float OS |
| `linux-aarch64-rpi3` | `aarch64-unknown-linux-musl` | Raspberry Pi 3 or newer with a 64-bit OS; other AArch64 Linux hosts |
| `darwin-arm64` | `aarch64-apple-darwin` | Apple Silicon macOS |
| `darwin-x86_64` | `x86_64-apple-darwin` | Intel macOS |

`linux-x86_64` retains its existing archive name and uses musl. All Linux
tools must be statically linked: packaging rejects ELF interpreters and
shared-library dependencies. The workflow uses checksum-pinned musl C
cross-compilers for all three Linux targets. AArch64 uses the baseline target
without CPU-specific optimization. ARMv6 uses hard-float VFP C flags and
vendored OpenSSL instead of `ring`. There is no separate ARMv7 archive; use the
ARMv6 archive on a compatible 32-bit hard-float OS.

The macOS archives are built on native Apple Silicon and Intel runners, with
the deployment target set to macOS 13. They use macOS system libraries; the
Linux static-link requirement does not apply to them.

## Validation

Publication waits for every platform job and the Linux x86_64 installation
validation job. Every archive must pass architecture checks, source-revision
and checksum verification, and execution of all six tools. The walking-graph
tool builds a small graph. ARM binaries execute under QEMU with an ARM1176
CPU for ARMv6 and a Cortex-A53 CPU for AArch64. ELF ARM attributes are checked
for the hard-float ABI and, when present, the ARMv6 CPU level.

Full signed OSM builds, native browser checks, HTTP/TLS, updates and restarts,
and Docker lifecycle checks run on Linux x86_64. Other platform jobs run tool
smoke checks, not full installation checks. QEMU execution does not establish
real Raspberry Pi memory capacity or performance. See the
[hosting validation record](../examples/VALIDATION.md) for completed runs.

## Raspberry Pi deployment

Choose the archive for the operating system's architecture, not only the
board model. A Pi 3 running a 32-bit OS needs the ARMv6 archive; the AArch64
archive needs a 64-bit OS. Prefer native hosting on small boards. The reference
Docker Compose configuration remains Linux x86_64 only.

Build OSM data on a larger host and install the signed catalog on the Pi.
Node 22 and the OSM build tools are not prerequisites for serving a downloaded
catalog, and the local Node builder is not an ARMv6 runtime option. Building
OSM data and producing a large GTFS generation can exceed a small board's
memory. Binary compatibility does not guarantee that a particular city fits.

Source-driven GTFS refresh additionally requires Java 21 and timezone data for
canonical validation. On boards without a suitable JVM or memory capacity, run
[feed preparation](gtfs-sources.md) on a larger worker and transfer its validated
prepared inputs for generation building. Serving already-built generations does
not require Java. The ARM tool smoke checks do not validate this worker handoff.

## Versions

Download only assets actually listed on the chosen release. `v0.1.0` contains
the Linux x86_64 archive. The expanded matrix applies to subsequent releases;
it does not change that tag or its source revision. For build and packaging
instructions, see the [source README](https://github.com/uerban/ptn#installable-archive).
Tags with a prerelease suffix, such as `v0.1.1-rc.1`, create a prerelease
draft. Ordinary version tags create a regular release draft. Both require manual publication.

Build validation runs on pull requests and main; tags do not rebuild. The
separate `draft-release.yml` workflow resolves the tag to its exact commit and
reuses the five archives from a successful main validation run. Checksums and
archive source metadata are checked before creating the draft.

If no validation run exists, or all required artifacts exist but any have
expired, draft creation dispatches validation for that exact source commit
and waits. A failed build or missing required artifact fails immediately;
a partial successful run is never automatically rebuilt. Rerun validation
explicitly after fixing a partial run. Final archives are retained for 30 days.

For an existing tag (including tags predating this workflow), manually run
`draft-release.yml` on main with its `tag` input. This does not move the tag.
