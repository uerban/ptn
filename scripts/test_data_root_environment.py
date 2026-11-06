import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / 'examples/native'
sys.path.insert(0, str(NATIVE))
spec = importlib.util.spec_from_file_location('native_host', NATIVE / 'host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class DataRootEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_binds_a_fresh_root_with_the_same_identity_for_both_binaries(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(host.subprocess, 'run') as run:
            environment = host.data_root_environment({'dataRootId': 'release-1:vilnius'}, self.root, Path('/bin'))
        self.assertEqual(environment['PT_DATA_ROOT_ID'], 'release-1:vilnius')
        self.assertEqual(run.call_args.kwargs['env'], environment)
        self.assertEqual(run.call_args.args[0][-2:], ['--identity', 'release-1:vilnius'])
        self.assertNotIn('--expected-generation', run.call_args.args[0])

    def test_existing_binding_does_not_need_producer_or_its_lock(self):
        (self.root / '.data-root-identity.json').write_text('{}')
        with patch.dict(os.environ, {}, clear=True), patch.object(host.subprocess, 'run') as run:
            environment = host.data_root_environment({'dataRootId': 'release-1:vilnius'}, self.root, Path('/bin'))
        run.assert_not_called()  # Native verifier, not Python, validates the binding.
        self.assertEqual(environment['PT_DATA_ROOT_ID'], 'release-1:vilnius')

    def test_failed_binding_propagates_without_fetching_or_rebinding(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(host.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'bind')):
            with self.assertRaises(subprocess.CalledProcessError):
                host.data_root_environment({'dataRootId': 'release-1:vilnius'}, self.root, Path('/bin'))

    def test_conflicting_external_configuration_is_rejected(self):
        with patch.dict(os.environ, {'PT_DATA_ROOT_ID': 'other:vilnius'}, clear=True), patch.object(host.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                host.data_root_environment({'dataRootId': 'release-1:vilnius'}, self.root, Path('/bin'))
        run.assert_not_called()
