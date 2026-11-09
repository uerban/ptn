"""Routine binary checks must retain archive identity checks on the release path."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tools', Path(__file__).with_name('verify-release-tools.py'))
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)
REV = 'a' * 40


class ToolValidationTests(unittest.TestCase):
    def bundle(self, root):
        bundle = root / 'ptn-linux-x86_64'
        bundle.mkdir()
        archive = bundle.with_suffix('.tar.gz')
        archive.write_bytes(b'fixture archive')
        archive.with_suffix('.gz.sha256').write_text(f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n')
        (bundle / 'release.json').write_text(json.dumps({
            'revision': REV, 'sourceDirty': False, 'rustTarget': 'x86_64-unknown-linux-musl'}))
        (bundle / 'fixture').write_bytes(b'payload')
        (bundle / 'SHA256SUMS').write_text(f'{hashlib.sha256(b"payload").hexdigest()}  fixture\n')
        return bundle

    def test_archive_mode_still_verifies_identity_and_checksums_before_smoke(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.bundle(Path(directory))
            with patch('sys.argv', ['verify', '--bundle', str(bundle), '--revision', REV]), \
                    patch.object(tools, 'verify_tools') as smoke:
                tools.main()
                smoke.assert_called_once_with([], bundle.resolve() / 'bin', 'x86_64-unknown-linux-musl')
                (bundle / 'fixture').write_bytes(b'tampered')
                with self.assertRaises(AssertionError):
                    tools.main()
                self.assertEqual(smoke.call_count, 1)

    def test_wrong_revision_and_dirty_archive_cannot_use_direct_mode_to_bypass_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.bundle(Path(directory))
            for revision, dirty in [('b' * 40, False), (REV, True)]:
                (bundle / 'release.json').write_text(json.dumps({
                    'revision': revision, 'sourceDirty': dirty, 'rustTarget': 'x86_64-unknown-linux-musl'}))
                with patch('sys.argv', ['verify', '--bundle', str(bundle), '--revision', REV]), \
                        patch.object(tools, 'verify_tools') as smoke, self.assertRaises(AssertionError):
                    tools.main()
                smoke.assert_not_called()

    def test_direct_mode_rejects_wrong_binary_architecture_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'pt-serve').write_bytes(b'not a static ARM executable')
            with patch('sys.argv', ['verify', '--bin-dir', str(root), '--platform', 'linux-armv6-rpi1']), \
                    patch.object(tools, 'verify_tools') as smoke, self.assertRaisesRegex(ValueError, 'ELF'):
                tools.main()
            smoke.assert_not_called()

    def test_probe_checks_real_graph_output_and_preserves_emulator(self):
        commands = []
        def execute(command, **kwargs):
            commands.append(command)
            if 'pt-walk-build' in command[-1] or '--out' in command:
                output = Path(command[command.index('--out') + 1])
                output.write_bytes(b'PTWGfixture')
                stdout = '{"nodes": 2, "edges": 1}'
            else:
                stdout = 'Usage: fixture'
            class Result:
                pass
            result = Result()
            result.stdout = stdout
            return result
        with patch.object(tools.subprocess, 'run', side_effect=execute), \
                patch.object(tools, 'verify_native_tls') as tls:
            tools.verify_tools(['qemu-arm', '-cpu', 'arm1176'], Path('/fixture/bin'), 'arm-unknown-linux-musleabihf')
            self.assertEqual(len(commands), 12)
            self.assertTrue({'pt-transit', 'pt-pack-inspect', 'pt-pack-export',
                             'pt-pack-catalog', 'pt-pack-publish', 'pt-pack-discovery'}
                            <= {Path(command[3]).name for command in commands})
            self.assertTrue(all(command[:3] == ['qemu-arm', '-cpu', 'arm1176'] for command in commands))
            tls.assert_called_once()


if __name__ == '__main__':
    unittest.main()
