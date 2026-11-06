"""Release promotion policy: missing is an error even alongside expiry."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import json

spec = importlib.util.spec_from_file_location('draft', Path(__file__).with_name('prepare-release-draft.py'))
draft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(draft)


class ArtifactPolicyTests(unittest.TestCase):
    def artifacts(self):
        return [{'name': name, 'expired': False} for name in sorted(draft.REQUIRED)]

    def test_stable_tag_cannot_dispatch_a_rebuild(self):
        with patch('sys.argv', ['prepare-release-draft.py', 'v0.2.0']), patch.object(draft, 'gh') as gh:
            with self.assertRaisesRegex(RuntimeError, 'promoted from an immutable RC'):
                draft.main()
            gh.assert_not_called()

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


class RegressionGateTests(unittest.TestCase):
    revision = 'a' * 40

    def proof(self):
        return {'schemaVersion': 1, 'revision': self.revision, 'runner': 'Linux', 'passed': True, 'sourceDirty': False, 'runId': '12',
                'checks': {name: 'success' for name in draft.REGRESSION_CHECKS}}

    def test_complete_exact_commit_proof(self):
        draft.validate_regression_proof(self.proof(), self.revision, 12)

    def test_wrong_commit_and_skipped_workloads_rejected(self):
        proof = self.proof()
        with self.assertRaisesRegex(RuntimeError, 'another source revision'):
            draft.validate_regression_proof(proof, 'b' * 40, 12)
        for outcome in ('skipped', 'failure', 'cancelled'):
            proof = self.proof()
            proof['checks']['heap'] = outcome
            with self.assertRaises(RuntimeError):
                draft.validate_regression_proof(proof, self.revision, 12)

    def test_dirty_source_or_proof_from_another_run_rejected(self):
        proof = self.proof()
        proof['sourceDirty'] = True
        with self.assertRaises(RuntimeError):
            draft.validate_regression_proof(proof, self.revision, 12)
        with self.assertRaises(RuntimeError):
            draft.validate_regression_proof(self.proof(), self.revision, 13)

    def test_missing_workload_and_advisory_report_rejected(self):
        proof = self.proof()
        del proof['checks']['coldstart']
        with self.assertRaises(RuntimeError):
            draft.validate_regression_proof(proof, self.revision, 12)
        proof = self.proof()
        proof['passed'] = False
        with self.assertRaises(RuntimeError):
            draft.validate_regression_proof(proof, self.revision, 12)

    def test_only_trusted_dispatches_can_satisfy_release_gate(self):
        run = {'event': 'workflow_dispatch', 'head_branch': 'main', 'head_sha': 'b' * 40,
               'display_title': f'Regression gates {self.revision}'}
        # Dispatch head_sha identifies the workflow code, not its checked-out input.
        self.assertTrue(draft.eligible_run(run, self.revision, 'Regression gates'))
        self.assertFalse(draft.eligible_run({**run, 'head_branch': 'feature'}, self.revision, 'Regression gates'))
        self.assertFalse(draft.eligible_run({**run, 'event': 'pull_request'}, self.revision, 'Regression gates'))
        self.assertFalse(draft.eligible_run(run, 'c' * 40, 'Regression gates'))

    def test_newest_failure_does_not_fall_back_to_an_old_success(self):
        base = {'event': 'workflow_dispatch', 'head_branch': 'main',
                'display_title': f'Regression gates {self.revision}', 'status': 'completed'}
        runs = [{'workflow_runs': [{**base, 'id': 1, 'conclusion': 'success'},
                                  {**base, 'id': 2, 'conclusion': 'failure'}]}]
        with patch.object(draft, 'gh', return_value=json.dumps(runs)) as gh:
            with self.assertRaisesRegex(RuntimeError, 'run 2 failed'):
                draft.ensure_validation('example/ptn', self.revision, 'regression.yml',
                                        'Regression gates', {'regression-proof'}, False)
            self.assertEqual(gh.call_count, 1)

    def test_check_only_never_dispatches_an_unbuilt_gate(self):
        with patch.object(draft, 'gh', return_value='[{"workflow_runs": []}]') as gh:
            with self.assertRaisesRegex(RuntimeError, 'unbuilt'):
                draft.ensure_validation('example/ptn', self.revision, 'regression.yml',
                                        'Regression gates', {'regression-proof'}, True)
            self.assertEqual(gh.call_count, 1)

    def test_missing_proof_is_not_a_successful_gate(self):
        with self.assertRaisesRegex(RuntimeError, 'Missing required artifacts'):
            draft.artifact_state([], {'regression-proof'})


if __name__ == '__main__':
    unittest.main()
