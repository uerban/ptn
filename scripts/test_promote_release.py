"""Immutable promotion must retain RC bytes and fail closed on identity changes."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promote', Path(__file__).with_name('promote-release.py'))
promote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promote)
REV = 'a' * 40


class PromotionTests(unittest.TestCase):
    def release(self):
        return {'tag_name': 'v0.2.0-rc.1', 'draft': False, 'prerelease': True, 'immutable': True,
                'assets': [{'name': name, 'digest': 'sha256:' + 'b' * 64}
                           for name in sorted(promote.ARCHIVES | promote.EVIDENCE)]}

    def test_published_immutable_rc_is_accepted(self):
        promote.validate_source(self.release(), 'v0.2.0-rc.1', 'v0.2.0', REV)

    def test_mutable_draft_and_wrong_channel_rejected(self):
        for field, value in [('immutable', False), ('immutable', None), ('draft', True), ('prerelease', False)]:
            release = self.release()
            release[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(RuntimeError):
                promote.validate_source(release, 'v0.2.0-rc.1', 'v0.2.0', REV)

    def test_cross_version_or_non_rc_promotion_rejected(self):
        for source, target in [('v0.2.0-rc.1', 'v0.3.0'), ('v0.2.0', 'v0.2.0'),
                               ('v0.2.0-rc.1', 'v0.2.0-rc.2'), ('../escape', 'v0.2.0')]:
            with self.subTest(source=source, target=target), self.assertRaises(RuntimeError):
                promote.validate_source(self.release(), source, target, REV)

    def test_missing_duplicate_or_unhashed_asset_rejected(self):
        for change in ('missing', 'duplicate', 'digest'):
            release = self.release()
            if change == 'missing':
                release['assets'].pop()
            elif change == 'duplicate':
                release['assets'].append(copy.deepcopy(release['assets'][0]))
            else:
                release['assets'][0]['digest'] = None
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                promote.validate_source(release, 'v0.2.0-rc.1', 'v0.2.0', REV)

    def files(self, root):
        for name in promote.ARCHIVES | {'regression.json'}:
            (root / name).write_bytes(name.encode())
        evidence = {'schemaVersion': 1, 'revision': REV, 'sha256': {
            name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in promote.ARCHIVES | {'regression.json'}}}
        (root / 'release-evidence.json').write_text(json.dumps(evidence))
        release = self.release()
        for asset in release['assets']:
            asset['digest'] = 'sha256:' + hashlib.sha256((root / asset['name']).read_bytes()).hexdigest()
        return release

    def test_verified_downloads_preserve_all_original_hashes(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            release = self.files(root)
            self.assertEqual(promote.verify_downloads(root, release, REV)['revision'], REV)
            archive = next(iter(promote.ARCHIVES))
            (root / archive).write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
                promote.verify_downloads(root, release, REV)

    def test_incomplete_proof_or_wrong_source_rejected(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            release = self.files(root)
            with self.assertRaisesRegex(RuntimeError, 'source mismatch'):
                promote.verify_downloads(root, release, 'c' * 40)
            evidence = json.loads((root / 'release-evidence.json').read_text())
            evidence['sha256'].pop('regression.json')
            (root / 'release-evidence.json').write_text(json.dumps(evidence))
            for asset in release['assets']:
                asset['digest'] = 'sha256:' + hashlib.sha256((root / asset['name']).read_bytes()).hexdigest()
            with self.assertRaisesRegex(RuntimeError, 'complete artifact set'):
                promote.verify_downloads(root, release, REV)

    def test_promotion_copies_every_asset_without_workflow_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = self.files(root)
            release['html_url'] = 'https://github.com/example/ptn/releases/tag/v0.2.0-rc.1'
            runs = [{'status': 'completed', 'conclusion': 'success', 'event': 'workflow_dispatch',
                     'head_branch': 'main', 'display_title': f'{title} {REV}',
                     'path': f'.github/workflows/{workflow}'}
                    for workflow, title in [('regression.yml', 'Regression gates'), ('release.yml', 'Release validation')]]
            # Inject real complete proof and its original run IDs into the fixture.
            proof = {'schemaVersion': 1, 'revision': REV, 'passed': True, 'sourceDirty': False,
                     'runId': '1', 'runner': 'Linux', 'checks': {name: 'success' for name in
                     ('identity', 'wasm', 'parity', 'rss', 'index', 'bundle', 'heap', 'coldstart', 'cityswitch')}}
            (root / 'regression.json').write_text(json.dumps(proof))
            evidence = json.loads((root / 'release-evidence.json').read_text())
            evidence.update(regressionRunId='1', releaseRunId='2')
            evidence['sha256']['regression.json'] = hashlib.sha256((root / 'regression.json').read_bytes()).hexdigest()
            (root / 'release-evidence.json').write_text(json.dumps(evidence))
            for asset in release['assets']:
                asset['digest'] = 'sha256:' + hashlib.sha256((root / asset['name']).read_bytes()).hexdigest()
            with patch.dict('os.environ', GH_REPO='example/ptn'), patch.object(promote, 'api', side_effect=[
                    release, {'sha': REV}, {'sha': REV}, *runs, release]), patch.object(promote, 'gh') as gh, \
                    patch.object(promote.tempfile, 'TemporaryDirectory') as temporary:
                temporary.return_value.__enter__.return_value = directory
                with patch('sys.argv', ['promote-release.py', 'v0.2.0', '--from-rc', 'v0.2.0-rc.1']):
                    promote.main()
                calls = [call.args for call in gh.call_args_list]
                self.assertEqual([call[:2] for call in calls], [('release', 'download'), ('release', 'create')])
                uploaded = {Path(arg).name for arg in calls[1] if arg.startswith(directory + '/')}
                self.assertEqual(uploaded, promote.ARCHIVES | promote.EVIDENCE)
                self.assertIn('--draft', calls[1])

    def test_commit_mismatch_stops_before_download_or_build(self):
        with patch.dict('os.environ', GH_REPO='example/ptn'), patch.object(promote, 'api', side_effect=[
                self.release(), {'sha': REV}, {'sha': 'c' * 40}]), patch.object(promote, 'gh') as gh:
            with patch('sys.argv', ['promote-release.py', 'v0.2.0', '--from-rc', 'v0.2.0-rc.1']):
                with self.assertRaisesRegex(RuntimeError, 'exact same commit'):
                    promote.main()
            gh.assert_not_called()


if __name__ == '__main__':
    unittest.main()
