"""Check version synchronization against the repository's real manifests."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bump', Path(__file__).with_name('version.py'))
bump = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bump)


class BumpTests(unittest.TestCase):
    def test_valid_versions(self):
        for version in ('0.3.0', '1.0.0', '0.10.0'):
            bump.validate_version(version)

    def test_invalid_versions(self):
        for version in ('v0.3.0', '01.2.0', '1.2', '0.2.44', '0.3.0-rc.1', '1.2.0+meta', '1.2.0\n'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                bump.validate_version(version)

    def test_real_manifests_lockfile_and_idempotency(self):
        root = bump.ROOT
        manifests = ['Cargo.toml', 'package.json', 'crates/pt-wasm/pkg-web/package.json']
        manifests += [str(p.relative_to(root)) for p in (root / 'crates').glob('*/Cargo.toml')]
        manifests += [str(p.relative_to(root)) for p in (root / 'packages').glob('*/package.json')]
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            for name in [*manifests, 'Cargo.lock']:
                target = fixture / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / name, target)
            before = tomllib.loads((fixture / 'Cargo.lock').read_text())
            changes = bump.plan(fixture, manifests, '0.9.0')
            self.assertEqual(len(changes), 15)
            for path, content in changes.items():
                path.write_text(content)
            for name in manifests:
                path = fixture / name
                if path.suffix == '.json':
                    self.assertEqual(json.loads(path.read_text())['version'], '0.9.0')
                else:
                    data = tomllib.loads(path.read_text())
                    if 'package' in data:
                        self.assertEqual(data['package']['version'], '0.9.0')
            after = tomllib.loads((fixture / 'Cargo.lock').read_text())
            self.assertEqual([p for p in before['package'] if 'source' in p],
                             [p for p in after['package'] if 'source' in p])
            self.assertFalse(bump.plan(fixture, manifests, '0.9.0'))

    def test_component_selection_is_retired(self):
        with self.assertRaises(TypeError):
            bump.plan(bump.ROOT, bump.discover(bump.ROOT), '0.3.0', ['pt-serve'])

    def test_current_delegates_to_app_version(self):
        with patch.object(bump.subprocess, 'check_output', return_value='0.2.44\n') as run:
            self.assertEqual(bump.current(bump.ROOT, 'v0.2.2'), '0.2.44')
        run.assert_called_once_with(['node', 'scripts/app-version.mjs', 'v0.2.2'], cwd=bump.ROOT, text=True)

    def test_list_reports_actual_source_values(self):
        manifests = bump.discover(bump.ROOT)
        rows = bump.list_versions(bump.ROOT, manifests)
        for kind, name, version, source in rows:
            text = (bump.ROOT / source).read_text()
            package = json.loads(text) if source.endswith('.json') else tomllib.loads(text)['package']
            self.assertEqual((name, version), (package['name'], package['version']))
        self.assertEqual({row[0] for row in rows}, {'crate', 'wasm', 'node'})
        self.assertEqual(len(rows), len(manifests) - 1)  # Root Cargo manifest has no package.

    def test_missing_workspace_lock_entry_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'Cargo.toml').write_text('[package]\nname = "test"\nversion = "0.1.0"\n')
            (root / 'Cargo.lock').write_text('version = 4\n')
            with self.assertRaisesRegex(ValueError, 'missing from Cargo.lock'):
                bump.plan(root, ['Cargo.toml'], '0.3.0')
            self.assertIn('0.1.0', (root / 'Cargo.toml').read_text())


if __name__ == '__main__':
    unittest.main()
