# Release platforms

The release workflow packages these targets from one source revision. Each
archive contains twelve native tools, matching PWA assets, the local OSM builder,
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

The archives include `pt-transit` for installing signed prebuilt transit packs
and `pt-pack-inspect`, `pt-pack-export`, `pt-pack-catalog`, `pt-pack-publish` and
`pt-pack-discovery` for builder-side validation and publication. Self-hosts need
only `pt-transit`, `pt-serve` and the matching web assets for transit hosting;
see the [transit installation guide](transit-pack-installation.md). Signing keys
belong on the publisher, never on consumer hosts.

## Validation

Publication waits for every platform job and the Linux x86_64 installation
validation job. Every archive must pass architecture checks, source-revision
and checksum verification, and execution of all twelve tools. The walking-graph
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

Every build reports one application version, in Settings, at `/version`, in
the `X-App-Version` header and in the archive's `release.json`:

| Build | Version |
| --- | --- |
| A commit on main | `X.Y.N` |
| Any other commit (feature branch, PR) | `X.Y.N-dev+<sha>` |
| A branch that raises major.minor, not yet merged | `X.Y.0-dev+<sha>` |
| No usable history (shallow clone, no git) | `X.Y.0-dev` |

`X.Y` comes from the root `package.json`. `N` counts main's first-parent
commits since the merge that introduced `X.Y`; every merge counts, so numbers
between releases have gaps by design. For a commit off main, `N` is that of the
newest main commit it builds on. The same commit always yields the same version.
`python3 scripts/version.py current [rev]` prints it.

`release.yml` computes the version once from full history and passes it to
every build as `PT_VERSION`, so all archives of a run agree. Pull request CI
builds from a shallow clone and shows `X.Y.0-dev`. Image builds outside CI can
pass the computed value with `--build-arg PT_VERSION=...`.

Download only assets actually listed on the chosen release. `v0.1.0` contains
the Linux x86_64 archive. The expanded matrix applies to subsequent releases;
it does not change that tag or its source revision. For build and packaging
instructions, see the [source README](https://github.com/uerban/ptn#installable-archive).

## Releasing

1. Pick a main commit whose release validation passed. Its version is in that
   run's summary and in `python3 scripts/version.py current <sha>`.
2. Tag it `vX.Y.N` with that exact version and push the tag. `draft-release.yml`
   creates a prerelease draft. It rejects the tag if the archives were built as
   another version, which also rejects tags on commits that are not on main.
3. Publish the draft. It stays a prerelease while it is staged.
4. Promote it by running `promote-release.yml` with `tag: vX.Y.N`. This clears
   the prerelease flag and marks it latest; the assets and tag do not change.

There are no release branches and no `-rc` tags. A fix for a release is merged
to main and released under its own, higher `N`. Legacy `vX.Y.Z-rc.N` releases
are still drafted, and promoted to a stable `vX.Y.Z` draft with
`source-rc` set.

Build validation runs on pull requests and main; tags do not rebuild. The
draft workflow resolves the tag to its exact commit and reuses the five
archives from a successful main validation run. Checksums, archive source
metadata and version are checked before creating the draft.

If no validation run exists, or all required artifacts exist but any have
expired, draft creation dispatches validation for that exact source commit
and waits. A failed build or missing required artifact fails immediately;
a partial successful run is never automatically rebuilt. Rerun validation
explicitly after fixing a partial run. Final archives are retained for 30 days.

For an existing tag, manually run `draft-release.yml` on main with its `tag`
input. This does not move the tag.

## Raising major.minor

The patch is never set by hand. To start a new minor or major, raise it on the
branch that introduces the change:

```sh
pnpm version:bump 0.3.0        # or: python3 scripts/version.py bump 0.3.0
python3 scripts/version.py list
```

This sets the root and workspace JavaScript packages, every Rust crate, the
tracked WASM package manifest, and workspace entries in `Cargo.lock` to `X.Y.0`.
Only `X.Y.0` is accepted. Use `--dry-run` to preview edits or `--check` to fail
if the manifests differ. The branch builds as `X.Y.0-dev+<sha>`; its merge to
main is `X.Y.0`, and numbering restarts from there.

The pnpm lockfile uses workspace links and does not store these packages' own
versions, so it needs no version-only update. Dependency versions, toolchain
pins, and binary/wire-format versions are unchanged. The script does not create
commits, tags, or releases.

## Release notes

Use the [release-notes template](templates/release-notes.md). Copy it to a
temporary file, fill its placeholders from the tagged source, compare with the
previous release, and check the successful validation run and attached assets.
Remove unused sections and template comments before publishing.

The draft workflow adds basic provenance notes automatically. Replace those
notes with the reviewed release message before publication:

```sh
cp docs/templates/release-notes.md /tmp/ptn-release-notes.md
# Edit /tmp/ptn-release-notes.md and replace all placeholders.
gh release edit vX.Y.N --repo uerban/ptn --notes-file /tmp/ptn-release-notes.md
```

This updates the existing draft. Publish it separately after the release notes
and assets are ready.
