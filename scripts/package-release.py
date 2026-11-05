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
BINARIES = ("pt-serve", "pt-producer", "pt-build-transfers", "pt-artifacts", "pt-walk-build", "pt-artifact-publish")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=("linux-x86_64", "darwin-arm64"))
    parser.add_argument("--bin-dir", type=Path, default=ROOT / "target/release")
    parser.add_argument("--out", type=Path, default=ROOT / "release")
    args = parser.parse_args()
    web = ROOT / "packages/frontend/dist"
    for path in [*(args.bin_dir / name for name in BINARIES), web / "index.html"]:
        if not path.is_file():
            parser.error(f"missing build output: {path}")
    if args.platform == "linux-x86_64":
        for name in BINARIES:
            with (args.bin_dir / name).open("rb") as binary:
                header = binary.read(20)
            if header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != 62:
                parser.error(f"{name} is not a Linux x86_64 ELF executable")
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
        shutil.copytree(ROOT / "release-builder", bundle / "builder")
        for filename in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(ROOT / filename, bundle / filename)
        (bundle / "README.md").write_text(
            "# PTN host archive\n\n"
            "Start with [the native host guide](examples/native/README.md). "
            "It covers local OSM builds, initialization, localhost, HTTPS and updates.\n\n"
            "Run `sha256sum --check SHA256SUMS` to verify the extracted files. "
            "`release.json` identifies the source revision and platform.\n\n"
            "[Source and build instructions](https://github.com/uerban/ptn#build).\n"
        )
        (bundle / "release.json").write_text(json.dumps({
            "schemaVersion": 1, "revision": revision, "platform": args.platform,
            "sourceDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        }, indent=2) + "\n")
        lines = []
        for path in sorted(bundle.rglob("*")):
            if path.is_file():
                lines.append(f"{hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}  {path.relative_to(bundle)}\n")
        (bundle / "SHA256SUMS").write_text("".join(lines))
        archive = args.out / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            output.add(bundle, arcname=name)
    digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest}  {archive.name}\n")
    print(archive)


if __name__ == "__main__":
    main()
