import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('scope', Path(__file__).with_name('ci-scope.py'))
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def test_prose_only(self):
        self.assertTrue(scope.documentation_only(['README.md', 'docs/hosting.md', 'CONTRIBUTING.md', 'examples/native/README.md']))

    def test_executable_and_budget_docs_require_build(self):
        for path in ['docs/budgets.json', 'docs/example.py', '.github/workflows/ci.yml', 'Cargo.lock',
                     'packages/frontend/src/template.md', 'scripts/check.py']:
            self.assertFalse(scope.documentation_only(['README.md', path]), path)

    def test_dependency_scope_covers_lockfiles_manifests_and_workflow_policy(self):
        for path in ['Cargo.lock', 'crates/pt-core/Cargo.toml', 'packages/frontend/package.json',
                     'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/actions/setup-build/action.yml']:
            self.assertTrue(scope.dependency_changes([path]), path)
        self.assertFalse(scope.dependency_changes(['README.md', 'docs/ci.md', 'crates/pt-core/src/lib.rs']))

    def test_empty_and_unknown_events_run(self):
        self.assertFalse(scope.documentation_only([]))
        self.assertIsNone(scope.changed_paths('workflow_dispatch', {}))
        self.assertIsNone(scope.changed_paths('push', {'before': '0' * 40}))

    @patch.object(scope.subprocess, 'check_output', return_value=b'README.md\0docs/budgets.json\0')
    def test_push_uses_full_before_range_and_retains_all_paths(self, run):
        paths = scope.changed_paths('push', {'before': 'a' * 40})
        self.assertFalse(scope.documentation_only(paths))
        self.assertIn('a' * 40 + '..HEAD', run.call_args.args[0])
        self.assertIn('--no-renames', run.call_args.args[0])

    @patch.object(scope.subprocess, 'check_output', return_value=b'README.md\0')
    def test_pr_uses_merge_base(self, run):
        scope.changed_paths('pull_request', {'pull_request': {'base': {'sha': 'b' * 40}}})
        self.assertIn('b' * 40 + '...HEAD', run.call_args.args[0])
