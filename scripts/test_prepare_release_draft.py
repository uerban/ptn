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

    def test_malformed_tag_is_rejected_before_any_github_call(self):
        for tag in ('v0.2', 'v0.2.44-rc', 'v01.2.3', '0.2.44', 'v0.2.44-dev+abcdef12'):
            with self.subTest(tag=tag), patch('sys.argv', ['prepare-release-draft.py', tag]), \
                    patch.object(draft, 'gh') as gh, self.assertRaisesRegex(RuntimeError, 'Expected a release tag'):
                draft.main()
            gh.assert_not_called()

    def test_legacy_stable_tag_is_refused_before_any_gate_runs(self):
        with patch('sys.argv', ['prepare-release-draft.py', 'v0.2.3']), patch.dict('os.environ', GH_REPO='example/ptn'), \
                patch.object(draft, 'api', return_value=[{'ref': 'refs/tags/v0.2.3-rc.4'}]) as api, \
                patch.object(draft, 'gh') as gh, self.assertRaisesRegex(RuntimeError, 'legacy stable tag'):
            draft.main()
        api.assert_called_once_with('repos/example/ptn/git/matching-refs/tags/v0.2.3-rc.')
        gh.assert_not_called()

    def test_release_tags_carry_their_version_and_legacy_rc_tags_do_not(self):
        self.assertEqual(draft.tag_version('v0.2.44'), '0.2.44')
        self.assertIsNone(draft.tag_version('v0.2.3-rc.4'))

    def test_archive_must_be_built_as_the_tagged_version(self):
        draft.check_archive_version({'version': '0.2.44'}, '0.2.44', 'ptn-linux-x86_64.tar.gz')
        draft.check_archive_version({}, None, 'ptn-linux-x86_64.tar.gz')  # legacy RC
        for meta in ({'version': '0.2.43'}, {'version': '0.2.44-dev+abcdef12'}, {}):
            with self.subTest(meta=meta), self.assertRaisesRegex(RuntimeError, 'derived version matches'):
                draft.check_archive_version(meta, '0.2.44', 'ptn-linux-x86_64.tar.gz')

    def test_complete_artifacts_are_reused(self):
        self.assertEqual(draft.artifact_state(self.artifacts()), 'ready')

    def test_main_push_archives_are_reused_without_dispatch(self):
        revision = 'a' * 40
        run = {'id': 42, 'event': 'push', 'head_branch': 'main',
               'head_sha': revision, 'status': 'completed', 'conclusion': 'success'}
        with patch.object(draft, 'gh', return_value=json.dumps([
                {'workflow_runs': [run]}])) as gh, patch.object(
                draft, 'api', return_value={'artifacts': self.artifacts()}):
            selected = draft.ensure_validation('example/ptn', revision, 'release.yml',
                                               'Release validation', draft.REQUIRED,
                                               False, allow_main_push=True)
            self.assertEqual(selected, run)
            self.assertEqual(gh.call_count, 1)

    def test_push_reuse_requires_main_and_exact_revision(self):
        revision = 'a' * 40
        run = {'event': 'push', 'head_branch': 'main', 'head_sha': revision}
        for updates in ({'head_branch': 'feature'}, {'head_sha': 'b' * 40}):
            self.assertFalse(draft.eligible_run({**run, **updates}, revision,
                                               'Release validation', allow_main_push=True))

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


class ReleaseNotesTests(unittest.TestCase):
    values = {'VERSION': '0.2.50', 'TAG': 'v0.2.50', 'PREVIOUS_TAG': 'v0.2.49',
              'VALIDATION_RUN_URL': 'https://example.test/runs/2', 'REGRESSION_RUN_URL': 'https://example.test/runs/1',
              'SOURCE_SHA': 'a' * 40, 'SHORT_SHA': 'a' * 7, 'PULL_REQUESTS': '* fix: one by @someone in #1'}

    def test_draft_title_names_the_product(self):
        self.assertEqual(draft.release_title('v0.2.50'), 'PTN v0.2.50')

    def test_template_renders_provenance_and_keeps_editorial_placeholders(self):
        notes = draft.render_notes(draft.TEMPLATE.read_text(), self.values)
        self.assertTrue(notes.startswith('PTN 0.2.50 {{SUMMARY}}'))
        self.assertNotIn('<!--', notes)
        self.assertEqual(set(draft.PLACEHOLDER.findall(notes)), set(draft.EDITORIAL))
        for expected in ('https://example.test/runs/2', 'https://example.test/runs/1', 'a' * 40,
                         '/blob/v0.2.50/docker/README.md', 'compare/v0.2.49...v0.2.50', '* fix: one by @someone in #1'):
            self.assertIn(expected, notes)

    def test_unknown_template_placeholder_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'unknown placeholders: TYPO'):
            draft.render_notes('PTN {{VERSION}} {{TYPO}}', self.values)

    def test_pull_requests_come_from_generated_notes_since_previous_release(self):
        body = "## What's Changed\n* feat: a by @x in https://example.test/pull/1\n* fix: b by @x in https://example.test/pull/2\n\n**Full Changelog**: ..."
        with patch.object(draft, 'gh', return_value=json.dumps({'name': 'v0.2.50', 'body': body})) as gh:
            self.assertEqual(draft.pull_requests('example/ptn', 'v0.2.50', 'v0.2.49'),
                             '* feat: a by @x in https://example.test/pull/1\n* fix: b by @x in https://example.test/pull/2')
        self.assertEqual(gh.call_args.args, ('api', '-X', 'POST', 'repos/example/ptn/releases/generate-notes',
                                             '-f', 'tag_name=v0.2.50', '-f', 'previous_tag_name=v0.2.49'))


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
