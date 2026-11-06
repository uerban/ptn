#!/usr/bin/env python3
"""Package already-built, matching native binaries and PWA assets."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BINARIES = (
    "pt-serve", "pt-producer", "pt-build-transfers", "pt-artifacts",
    "pt-walk-build", "pt-artifact-publish", "pt-transit", "pt-pack-inspect",
    "pt-pack-export", "pt-pack-catalog", "pt-pack-publish", "pt-pack-discovery",
)
TRANSIT_DOCS = (
    "transit-pack-installation.md", "transit-pack-inventory.md",
    "transit-pack-publication.md",
)
PLATFORMS = {
    "linux-x86_64": ("x86_64-unknown-linux-musl", 2, 62),
    "linux-armv6-rpi1": ("arm-unknown-linux-musleabihf", 1, 40),
    "linux-aarch64-rpi3": ("aarch64-unknown-linux-musl", 2, 183),
    "darwin-arm64": ("aarch64-apple-darwin", None, 0x0100000C),
    "darwin-x86_64": ("x86_64-apple-darwin", None, 0x01000007),
}


def verify_binary(path, platform):
    """Reject wrong-architecture archives and dynamically linked Linux tools."""
    _, elf_class, machine = PLATFORMS[platform]
    data = path.read_bytes()
    if elf_class is None:
        if len(data) < 32 or data[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack_from("<I", data, 4)[0] != machine:
            raise ValueError(f"{path.name} is not a {platform} Mach-O executable")
        if struct.unpack_from("<I", data, 12)[0] != 2:  # MH_EXECUTE
            raise ValueError(f"{path.name} is not a Mach-O executable")
        return
    header_size = 64 if elf_class == 2 else 52
    if len(data) < header_size or data[:6] != b"\x7fELF" + bytes([elf_class, 1]) or struct.unpack_from("<H", data, 18)[0] != machine:
        raise ValueError(f"{path.name} is not a {platform} ELF executable")
    if struct.unpack_from("<H", data, 16)[0] not in (2, 3):  # ET_EXEC / static PIE
        raise ValueError(f"{path.name} is not an ELF executable")
    if elf_class == 2:
        phoff = struct.unpack_from("<Q", data, 32)[0]
        phsize, phnum = struct.unpack_from("<HH", data, 54)
        expected_size = 56
    else:
        phoff = struct.unpack_from("<I", data, 28)[0]
        phsize, phnum = struct.unpack_from("<HH", data, 42)
        expected_size = 32
        if struct.unpack_from("<I", data, 36)[0] & 0x600 != 0x400:
            raise ValueError(f"{path.name} does not use the ARM hard-float ABI")
    if not phnum or phsize != expected_size or phoff < header_size or phoff + phsize * phnum > len(data):
        raise ValueError(f"{path.name} has an invalid ELF program table")
    for index in range(phnum):
        offset = phoff + index * phsize
        kind = struct.unpack_from("<I", data, offset)[0]
        if kind == 3:  # PT_INTERP: needs a system dynamic loader
            raise ValueError(f"{path.name} is dynamically linked (PT_INTERP)")
        if kind == 2:  # PT_DYNAMIC: static PIE is allowed, DT_NEEDED is not
            if elf_class == 2:
                start = struct.unpack_from("<Q", data, offset + 8)[0]
                size = struct.unpack_from("<Q", data, offset + 32)[0]
                entry_size, tag_format = 16, "<Q"
            else:
                start = struct.unpack_from("<I", data, offset + 4)[0]
                size = struct.unpack_from("<I", data, offset + 16)[0]
                entry_size, tag_format = 8, "<I"
            if start + size > len(data) or size % entry_size:
                raise ValueError(f"{path.name} has an invalid ELF dynamic table")
            for entry in range(start, start + size, entry_size):
                tag = struct.unpack_from(tag_format, data, entry)[0]
                if tag == 0:
                    break
                if tag == 1:
                    raise ValueError(f"{path.name} needs a shared library (DT_NEEDED)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=PLATFORMS)
    parser.add_argument("--bin-dir", type=Path, default=ROOT / "target/release")
    parser.add_argument("--out", type=Path, default=ROOT / "release")
    args = parser.parse_args()
    web = ROOT / "packages/frontend/dist"
    for path in [*(args.bin_dir / name for name in BINARIES), web / "index.html"]:
        if not path.is_file():
            parser.error(f"missing build output: {path}")
    for name in BINARIES:
        try:
            verify_binary(args.bin_dir / name, args.platform)
        except ValueError as error:
            parser.error(str(error))
    builder = ROOT / "release-builder"
    for path in ("packages/backend/src/poi/buildArtifacts.mjs", "packages/backend/scripts/extract-addr-fixture.mjs"):
        if not (builder / path).is_file():
            parser.error("build the optional OSM tooling with node scripts/package-osm-builder.mjs")
    if not list((web / "assets").glob("*.wasm")):
        parser.error("PWA output has no WASM engine")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    args.out.mkdir(parents=True, exist_ok=True)
    name = f"ptn-{args.platform}"
    with tempfile.TemporaryDirectory() as work:
        bundle = Path(work) / name
        (bundle / "bin").mkdir(parents=True)
        for binary in BINARIES:
            shutil.copy2(args.bin_dir / binary, bundle / "bin" / binary)
        shutil.copytree(web, bundle / "web")
        shutil.copytree(ROOT / "examples/native", bundle / "examples/native", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(ROOT / "examples/VALIDATION.md", bundle / "examples/VALIDATION.md")
        (bundle / "docs").mkdir()
        shutil.copy2(ROOT / "docs/release-platforms.md", bundle / "docs/release-platforms.md")
        shutil.copy2(ROOT / "docs/gtfs-sources.md", bundle / "docs/gtfs-sources.md")
        shutil.copy2(ROOT / "docs/runtime-cities.md", bundle / "docs/runtime-cities.md")
        for filename in TRANSIT_DOCS:
            shutil.copy2(ROOT / "docs" / filename, bundle / "docs" / filename)
        shutil.copytree(ROOT / "release-builder", bundle / "builder")
        for filename in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(ROOT / filename, bundle / filename)
        (bundle / "README.md").write_text(
            "# PTN host archive\n\n"
            "Start with [the native host guide](examples/native/README.md). "
            "It covers local OSM builds, initialization, localhost, HTTPS and updates.\n\n"
            "For prebuilt transit without feed or OSM builds, use the "
            "[transit installation guide](docs/transit-pack-installation.md).\n\n"
            "Run `sha256sum --check SHA256SUMS` to verify the extracted files. "
            "`release.json` identifies the source revision and platform.\n\n"
            "[Source and build instructions](https://github.com/uerban/ptn#build).\n"
        )
        (bundle / "release.json").write_text(json.dumps({
            "schemaVersion": 1, "revision": revision, "platform": args.platform,
            "rustTarget": PLATFORMS[args.platform][0],
            "sourceDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        }, indent=2) + "\n")
        lines = []
        for path in sorted(bundle.rglob("*")):
            if path.is_file():
                with path.open("rb") as stream:
                    lines.append(f"{hashlib.file_digest(stream, 'sha256').hexdigest()}  {path.relative_to(bundle)}\n")
        (bundle / "SHA256SUMS").write_text("".join(lines))
        archive = args.out / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            output.add(bundle, arcname=name)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest}  {archive.name}\n")
    print(archive)


if __name__ == "__main__":
    main()
