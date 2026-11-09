"""Exercise both lifecycle verifiers through their direct reload invocation."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReloadReached(Exception):
    pass


class InstallationIdentityTests(unittest.TestCase):
    def check_reload(self, kind):
        verifier = load(f'verify-{kind}-installation')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.json'
            identity = 'custom-deployment:vilnius'
            source.write_text(json.dumps({'dataRootId': identity,
                'artifactSource': {'kind': 'local', 'directory': str(root)}}))
            evidence = root / 'evidence'
            argv = ['verify', '--source-config', str(source), '--evidence', str(evidence)]
            if kind == 'native':
                native = root / 'bundle/examples/native'
                native.mkdir(parents=True)
                (native / 'config.example.json').write_text('{}')
                (native / 'Caddyfile').write_text('admin off')
                argv += ['--bundle', str(root / 'bundle'), '--caddy', 'caddy']

            def run(command, **kwargs):
                if 'republish' in command:
                    if kind == 'native':
                        self.assertEqual(kwargs['env']['PT_DATA_ROOT_ID'], identity)
                    else:
                        self.assertIn(f'PT_DATA_ROOT_ID={identity}', command)
                        index = command.index(f'PT_DATA_ROOT_ID={identity}')
                        self.assertEqual(command[index - 1], '-e')
                        self.assertLess(index, command.index('transit'))
                    raise ReloadReached()
                return MagicMock(returncode=0)

            # Stop at reload: bootstrap/browser/TLS are covered by release CI.
            with patch.object(verifier, 'free_port', side_effect=range(19000, 19005)), \
                 patch.object(sys, 'argv', argv), \
                 patch.dict(os.environ, {}, clear=True), \
                 patch.object(verifier.subprocess, 'run', side_effect=run), \
                 patch.object(verifier.subprocess, 'Popen'), \
                 patch.object(verifier.urllib.request, 'urlopen', side_effect=lambda *a, **k:
                     io.StringIO('{"status":"ready","servingGenerationId":"initial"}')), \
                 patch.object(verifier.ssl, 'create_default_context'), \
                 patch.object(verifier.time, 'sleep'), \
                 patch.object(verifier, 'change_stop_label', create=True):
                with self.assertRaises(ReloadReached):
                    verifier.main()

    def test_native_reload_uses_configured_identity(self):
        self.check_reload('native')

    def test_docker_reload_uses_configured_identity(self):
        self.check_reload('docker')
