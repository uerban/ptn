"""Release promotion policy: missing is an error even alongside expiry."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('draft', Path(__file__).with_name('prepare-release-draft.py'))
draft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(draft)


class ArtifactPolicyTests(unittest.TestCase):
    def artifacts(self):
        return [{'name': name, 'expired': False} for name in sorted(draft.REQUIRED)]

    def test_complete_artifacts_are_reused(self):
        self.assertEqual(draft.artifact_state(self.artifacts()), 'ready')

    def test_expired_artifacts_require_rebuild(self):
        artifacts = self.artifacts()
        artifacts[0]['expired'] = True
        self.assertEqual(draft.artifact_state(artifacts), 'expired')

    def test_missing_artifact_fails_fast(self):
        with self.assertRaisesRegex(RuntimeError, 'refusing automatic rebuild'):
            draft.artifact_state(self.artifacts()[1:])

    def test_missing_takes_precedence_over_expiry(self):
        artifacts = self.artifacts()[1:]
        artifacts[0]['expired'] = True
        with self.assertRaisesRegex(RuntimeError, 'refusing automatic rebuild'):
            draft.artifact_state(artifacts)

    def test_unvalidated_candidate_does_not_replace_final_archive(self):
        artifacts = [a for a in self.artifacts() if a['name'] != 'ptn-linux-x86_64']
        artifacts.append({'name': 'ptn-linux-x86_64-candidate', 'expired': False})
        with self.assertRaisesRegex(RuntimeError, 'Missing required artifacts: ptn-linux-x86_64'):
            draft.artifact_state(artifacts)


if __name__ == '__main__':
    unittest.main()
