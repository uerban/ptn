"""Packaging must reject incompatible or dynamically linked host binaries."""
import importlib.util
from pathlib import Path
import struct
import sys
import tarfile
import hashlib
from unittest.mock import patch
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).with_name("package-release.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def elf(bits, machine, *, flags=0, segment=1, needed=False):
    header_size, program_size = (64, 56) if bits == 64 else (52, 32)
    data = bytearray(header_size + program_size + 32)
    data[:6] = b"\x7fELF" + bytes([2 if bits == 64 else 1, 1])
    struct.pack_into("<HH", data, 16, 2, machine)
    if bits == 64:
        struct.pack_into("<Q", data, 32, header_size)
        struct.pack_into("<HH", data, 54, program_size, 1)
        struct.pack_into("<Q", data, header_size + 8, header_size + program_size)
        struct.pack_into("<Q", data, header_size + 32, 32)
    else:
        struct.pack_into("<I", data, 28, header_size)
        struct.pack_into("<I", data, 36, flags)
        struct.pack_into("<HH", data, 42, program_size, 1)
        struct.pack_into("<I", data, header_size + 4, header_size + program_size)
        struct.pack_into("<I", data, header_size + 16, 32)
    struct.pack_into("<I", data, header_size, segment)
    if needed:
        struct.pack_into("<I", data, header_size + program_size, 1)
    return data


class BinaryCompatibility(unittest.TestCase):
    def verify(self, data, platform):
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "tool"
            path.write_bytes(data)
            package.verify_binary(path, platform)

    def test_linux_targets(self):
        for platform, data in [
            ("linux-x86_64", elf(64, 62)),
            ("linux-aarch64-rpi3", elf(64, 183)),
            ("linux-armv6-rpi1", elf(32, 40, flags=0x5000400)),
        ]:
            with self.subTest(platform=platform):
                self.verify(data, platform)

    def test_wrong_architecture_or_word_size(self):
        for data in [elf(64, 183), elf(32, 62)]:
            with self.assertRaisesRegex(ValueError, "not a linux-x86_64 ELF"):
                self.verify(data, "linux-x86_64")

    def test_arm_soft_float_rejected(self):
        with self.assertRaisesRegex(ValueError, "hard-float"):
            self.verify(elf(32, 40, flags=0x5000200), "linux-armv6-rpi1")

    def test_dynamic_loader_rejected(self):
        with self.assertRaisesRegex(ValueError, "PT_INTERP"):
            self.verify(elf(64, 62, segment=3), "linux-x86_64")

    def test_static_pie_allowed_but_shared_libraries_rejected(self):
        for bits, machine, platform in [(64, 62, "linux-x86_64"), (32, 40, "linux-armv6-rpi1")]:
            data = elf(bits, machine, segment=2, flags=0x400)
            struct.pack_into("<H", data, 16, 3)
            self.verify(data, platform)
            with self.assertRaisesRegex(ValueError, "DT_NEEDED"):
                self.verify(elf(bits, machine, segment=2, needed=True, flags=0x400), platform)

    def test_truncated_program_table_rejected(self):
        with self.assertRaisesRegex(ValueError, "program table"):
            self.verify(elf(64, 62)[:80], "linux-x86_64")

    def test_macos_architectures_and_executable_type(self):
        for platform, cpu in [("darwin-arm64", 0x0100000C), ("darwin-x86_64", 0x01000007)]:
            data = bytearray(32)
            struct.pack_into("<IIII", data, 0, 0xFEEDFACF, cpu, 0, 2)
            self.verify(data, platform)
            other = "darwin-x86_64" if platform == "darwin-arm64" else "darwin-arm64"
            with self.assertRaisesRegex(ValueError, "Mach-O"):
                self.verify(data, other)
            struct.pack_into("<I", data, 12, 6)  # MH_DYLIB
            with self.assertRaisesRegex(ValueError, "executable"):
                self.verify(data, platform)

    def test_truncated_binary_rejected(self):
        for platform in package.PLATFORMS:
            with self.assertRaises(ValueError):
                self.verify(b"\x7fELF", platform)


class ArchiveContents(unittest.TestCase):
    def test_archive_contains_checksummed_recipe_runtime_and_guide(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            binaries = root / "binaries"
            binaries.mkdir()
            for name in package.BINARIES:
                (binaries / name).write_bytes(elf(64, 62))
            for name, content in {
                "packages/frontend/dist/index.html": "PWA",
                "packages/frontend/dist/assets/test.wasm": "WASM",
                "release-builder/packages/backend/src/poi/buildArtifacts.mjs": "builder",
                "release-builder/packages/backend/scripts/extract-addr-fixture.mjs": "extractor",
                "examples/native/gtfs.py": "recipe runtime",
                "examples/native/host.py": "host",
                "examples/native/prebuilt.py": "prebuilt adapter",
                "examples/native/prebuilt.md": "prebuilt guide",
                "examples/native/config.prebuilt.example.json": "prebuilt configuration",
                "examples/VALIDATION.md": "validation",
                "docs/release-platforms.md": "platforms",
                "docs/gtfs-sources.md": "sources",
                "docs/runtime-cities.md": "runtime city discovery",
                "LICENSE": "license", "LICENSE-MIT": "MIT", "LICENSE-APACHE": "Apache",
                "THIRD_PARTY_NOTICES.md": "notices",
            }.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            for filename in package.TRANSIT_DOCS:
                (root / "docs" / filename).write_text("transit guide")
            with patch.object(package, "ROOT", root), patch.object(sys, "argv", ["package-release.py", "--platform", "linux-x86_64", "--bin-dir", str(binaries), "--out", str(root / "out")]), patch.object(package.subprocess, "check_output", side_effect=["a" * 40, b""]), patch("builtins.print"):
                package.main()
            with tarfile.open(root / "out/ptn-linux-x86_64.tar.gz") as archive:
                checksums = archive.extractfile("ptn-linux-x86_64/SHA256SUMS").read().decode()
                for relative in ["examples/native/gtfs.py", "examples/native/prebuilt.py", "examples/native/prebuilt.md", "examples/native/config.prebuilt.example.json", "docs/gtfs-sources.md", *["bin/" + name for name in package.BINARIES], *["docs/" + name for name in package.TRANSIT_DOCS]]:
                    content = archive.extractfile("ptn-linux-x86_64/" + relative).read()
                    self.assertIn(hashlib.sha256(content).hexdigest() + "  " + relative, checksums)
