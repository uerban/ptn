import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'tools/search-pilot'
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('pilot_runner', HERE / 'runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@unittest.skipUnless(os.name == 'posix' and shutil.which('node'), 'POSIX and Node required for the capture runner')
class PilotRunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.base = Path(self.directory.name)
        self.root = self.base / 'pilot'
        self.source = self.base / 'source'
        (self.source / 'artifacts').mkdir(parents=True)
        (self.source / 'runs').mkdir()

    def tearDown(self):
        self.directory.cleanup()

    def initialize(self, body='return [];', timeout=1000, storage=64 * 1024 * 1024):
        # Controlled glue exercises the real supervisor/capture contract, not
        # GTFS routing correctness. Real-feed execution is separate evidence.
        values = {'ptb': b'fixture', 'wasm': b'fixture-wasm', 'glue': (
            'export function initSync(){} export class PtRouter {plan(){' + body + '} free(){}}').encode()}
        artifacts = {}
        for name, data in values.items():
            artifacts[name] = runner.sha(data)
            (self.source / 'artifacts' / artifacts[name]).write_bytes(data)
        record = {'schemaVersion': 1, 'completion': 'success', 'artifacts': artifacts}
        (self.source / 'runs/test.json').write_text(json.dumps(record))
        plan = {'format': 'ptn-search-pilot', 'version': 1, 'seed': 'fixture', 'timezone': 'Europe/Vilnius', 'artifacts': artifacts,
                'settings': {'objective': 'plan', 'patternMode': 'covering-merge', 'glueExecution': 'snapshot', 'iterations': 2, 'warmup': 0},
                'limits': {'maxJobs': 2, 'maxAttemptsPerJob': 2, 'attemptTimeoutMs': timeout, 'totalExecutionMs': 60000,
                           'maxStorageBytes': storage, 'attemptFileBytes': 65536},
                'jobs': [{'query': {'entryStops': [{'stopId': 'A', 'walkSecs': 0}], 'exitStops': [{'stopId': 'B', 'walkSecs': 0}],
                                    'date': '20261113', 'departureSecs': 0}, 'stratum': 'fixture', 'partition': 'synthetic'}]}
        return runner.initialize(self.root, self.source, 'test', plan)

    def records(self):
        ledger = runner.Ledger(self.root / 'pilot.sqlite')
        try:
            return ledger.records()
        finally:
            ledger.close()

    def test_real_capture_runner_repeats_empty_success_without_rerunning_completed_job(self):
        self.initialize()
        with patch.dict(os.environ, {'NODE_OPTIONS': '--import=/unretained/nonexistent.mjs'}):
            result = runner.run_step(self.root)
        self.assertEqual((result['completion'], result['candidateCount']), ('success', 0))
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(runner.run_step(self.root)['state'], 'finished')
        self.assertEqual(len(self.records()), 1)
        path = self.root / 'runs' / f"{result['captureRunId']}.json"
        capture = json.loads(path.read_text())
        self.assertEqual(capture['report']['input']['iterations'], 2)
        self.assertEqual(capture['report']['tuples'][0]['candidates'], [])

    def test_error_and_timeout_are_distinct_retained_attempts(self):
        for body, expected in [('throw new Error("fixture failure");', 'error'), ('while(true){}', 'timeout')]:
            with self.subTest(expected=expected):
                self.root = self.base / expected
                self.initialize(body, timeout=1000 if expected == 'error' else 500)
                first = runner.run_step(self.root)
                self.assertEqual(first['completion'], expected)
                self.assertIsNone(first['candidateCount'])
                second = runner.run_step(self.root)
                self.assertEqual(second['attempt'], 2)
                self.assertEqual(runner.run_step(self.root)['state'], 'finished')
                self.assertEqual([record['completion'] for record in self.records()], [expected, expected])

    def test_timeout_before_observed_inputs_remains_a_partial_timeout(self):
        self.initialize(timeout=1)
        result = runner.run_step(self.root)
        self.assertEqual(result['completion'], 'timeout')
        self.assertIsNone(result['candidateCount'])

    def test_completed_capture_reconciles_after_worker_result_commit_is_interrupted(self):
        self.initialize()
        with patch.object(runner.Ledger, 'complete', side_effect=RuntimeError('staged interruption after capture')):
            with self.assertRaisesRegex(RuntimeError, 'staged interruption'):
                runner.run_step(self.root)
        self.assertIsNone(self.records()[0]['completion'])
        self.assertEqual(runner.run_step(self.root)['state'], 'finished')
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertTrue(json.loads(records[0]['result'])['reconciled'])

    def test_reconciliation_rejects_a_mismatched_query_without_overwriting_capture(self):
        self.initialize()
        with patch.object(runner.Ledger, 'complete', side_effect=RuntimeError('staged interruption')):
            with self.assertRaises(RuntimeError):
                runner.run_step(self.root)
        token = self.records()[0]['token']
        path = self.root / 'runs' / f'{token}.json'
        capture = json.loads(path.read_text())
        capture['report']['tuples'][0]['query']['departureSecs'] = 1
        path.write_text(json.dumps(capture))
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'complete captured'):
            runner.run_step(self.root)
        self.assertEqual(path.read_bytes(), before)
        self.assertIsNone(self.records()[0]['completion'])

    def test_storage_admission_stops_before_reserving_an_attempt(self):
        self.initialize(storage=2 * 1024 * 1024)
        self.assertEqual(runner.run_step(self.root)['state'], 'storage-budget-exhausted')
        self.assertEqual(self.records(), [])

    def test_per_file_limit_leaves_failure_evidence_instead_of_empty_success(self):
        self.initialize('console.log("x".repeat(100000)); return [];')
        result = runner.run_step(self.root)
        self.assertEqual(result['completion'], 'error')
        self.assertIsNone(result['candidateCount'])
        for path in (self.root / 'attempts').rglob('*.bin'):
            self.assertLessEqual(path.stat().st_size, 65536)

    def test_corrupt_snapshot_or_changed_runtime_reject_before_any_attempt(self):
        plan = self.initialize()
        with patch.object(runner, 'runtime', return_value=({'different': 'runtime'}, Path('node'))):
            with self.assertRaisesRegex(ValueError, 'runtime changed'):
                runner.run_step(self.root)
        path = self.root / 'artifacts' / plan['artifacts']['wasm']
        path.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            runner.run_step(self.root)
        self.assertEqual(self.records(), [])

    def test_sigint_cancels_process_group_and_retains_cancelled_outcome(self):
        self.initialize('while(true){}', timeout=10000)
        child = subprocess.Popen([sys.executable, str(HERE / 'runner.py'), 'step', str(self.root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not list((self.root / 'attempts').glob('*/process.json')):
                self.assertIsNone(child.poll(), 'worker exited before starting its capture process')
                time.sleep(0.02)
            self.assertTrue(list((self.root / 'attempts').glob('*/process.json')))
            metadata = json.loads(next((self.root / 'attempts').glob('*/process.json')).read_text())
            child.send_signal(signal.SIGINT)
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 130, stderr)
            self.assertEqual(json.loads(stdout)['completion'], 'cancelled')
            self.assertEqual(self.records()[0]['completion'], 'cancelled')
            deadline = time.monotonic() + 3
            active = ['unknown']
            while time.monotonic() < deadline:
                states = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True)
                active = [line for line in states.splitlines() if line.split()[0] == str(metadata['processGroupId']) and line.split()[1][0] not in ('Z', 'X')]
                if not active:
                    break
                time.sleep(0.02)
            self.assertEqual(active, [], 'capture process group remains runnable after cancellation')
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
