"""Check version synchronization against the repository's real manifests."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import tomllib
import unittest

spec = importlib.util.spec_from_file_location('bump', Path(__file__).with_name('bump-version.py'))
bump = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bump)


class BumpTests(unittest.TestCase):
    def test_valid_versions(self):
        for version in ('0.1.2', '1.0.0', '0.2.0-rc.1'):
            bump.validate_version(version)

    def test_invalid_versions(self):
        for version in ('v0.1.2', '01.2.3', '1.2', '1.2.3-01', '1.2.3+meta', '1.2.3\n'):
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
            changes = bump.plan(fixture, manifests, '0.2.0-rc.1')
            self.assertEqual(len(changes), 15)
            for path, content in changes.items():
                path.write_text(content)
            for name in manifests:
                path = fixture / name
                if path.suffix == '.json':
                    self.assertEqual(json.loads(path.read_text())['version'], '0.2.0-rc.1')
                else:
                    data = tomllib.loads(path.read_text())
                    if 'package' in data:
                        self.assertEqual(data['package']['version'], '0.2.0-rc.1')
            after = tomllib.loads((fixture / 'Cargo.lock').read_text())
            self.assertEqual([p for p in before['package'] if 'source' in p],
                             [p for p in after['package'] if 'source' in p])
            self.assertFalse(bump.plan(fixture, manifests, '0.2.0-rc.1'))

    def test_crate_hotfix_leaves_other_versions_unchanged(self):
        manifests = ['Cargo.toml', 'package.json', 'crates/pt-wasm/pkg-web/package.json']
        manifests += [str(p.relative_to(bump.ROOT)) for p in (bump.ROOT / 'crates').glob('*/Cargo.toml')]
        changes = bump.plan(bump.ROOT, manifests, '0.1.2', ['pt-serve'])
        self.assertEqual({str(p.relative_to(bump.ROOT)) for p in changes},
                         {'crates/pt-serve/Cargo.toml', 'Cargo.lock'})
        before = tomllib.loads((bump.ROOT / 'Cargo.lock').read_text())['package']
        after = tomllib.loads(changes[bump.ROOT / 'Cargo.lock'])['package']
        self.assertEqual([p for p in before if p['name'] != 'pt-serve'],
                         [p for p in after if p['name'] != 'pt-serve'])

    def test_wasm_hotfix_includes_js_manifest_and_multiple_selection(self):
        manifests = ['crates/pt-wasm/Cargo.toml', 'crates/pt-serve/Cargo.toml',
                     'crates/pt-wasm/pkg-web/package.json', 'package.json']
        changes = bump.plan(bump.ROOT, manifests, '0.1.2', ['pt-wasm', 'pt-serve'])
        self.assertEqual({str(p.relative_to(bump.ROOT)) for p in changes},
                         {'crates/pt-wasm/Cargo.toml', 'crates/pt-serve/Cargo.toml',
                          'crates/pt-wasm/pkg-web/package.json', 'Cargo.lock'})
        self.assertEqual(json.loads(changes[bump.ROOT / 'crates/pt-wasm/pkg-web/package.json'])['version'], '0.1.2')

    def test_unknown_crate_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unknown workspace crates'):
            bump.plan(bump.ROOT, ['crates/pt-serve/Cargo.toml'], '0.1.2', ['pt-typo'])

    def test_missing_workspace_lock_entry_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'Cargo.toml').write_text('[package]\nname = "test"\nversion = "0.1.0"\n')
            (root / 'Cargo.lock').write_text('version = 4\n')
            with self.assertRaisesRegex(ValueError, 'missing from Cargo.lock'):
                bump.plan(root, ['Cargo.toml'], '0.1.2')
            self.assertIn('0.1.0', (root / 'Cargo.toml').read_text())


if __name__ == '__main__':
    unittest.main()
