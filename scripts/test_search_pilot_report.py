import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
import test_search_pilot_runner as fixtures

spec = importlib.util.spec_from_file_location('pilot_report', fixtures.HERE / 'report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


@unittest.skipUnless(os.name == 'posix' and shutil.which('node'), 'POSIX and Node required for retained capture fixtures')
class PilotReportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PilotRunnerTests('test_real_capture_runner_repeats_empty_success_without_rerunning_completed_job')
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def test_report_rechecks_empty_success_read_only_and_export_refuses_overwrite(self):
        self.fixture.initialize()
        fixtures.runner.run_step(self.fixture.root)
        before = {str(path.relative_to(self.fixture.root)): path.read_bytes() for path in self.fixture.root.rglob('*') if path.is_file()}
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('report must not execute a planner')):
            result = report.build_report(self.fixture.root, 100)
        self.assertEqual(result['jobCounts'], {'verified-empty': 1})
        self.assertEqual(result['executionStatus'], 'all-jobs-have-verified-captures')
        self.assertEqual(result['candidateDiagnostics']['candidatesInspected'], 0)
        self.assertEqual(result['reviewYield']['status'], 'not-evaluated')
        self.assertIsNone(result['qualityVerdict'])
        after = {str(path.relative_to(self.fixture.root)): path.read_bytes() for path in self.fixture.root.rglob('*') if path.is_file()}
        self.assertEqual(before, after)
        output = self.fixture.base / 'report.json'
        command = [sys.executable, str(fixtures.HERE / 'report.py'), str(self.fixture.root), '--out', str(output)]
        subprocess.run(command, check=True, capture_output=True)
        original = output.read_bytes()
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual(output.read_bytes(), original)

    def test_timeouts_errors_pending_and_unstarted_are_not_empty_results(self):
        frozen = self.fixture.initialize()
        plan = json.loads(json.dumps(frozen))
        first = plan['jobs'][0]
        second = json.loads(json.dumps(first))
        second.update({'partition': 'random', 'stratum': 'weekend'})
        second['query'].update({'date': '20261114', 'mobilityProfile': 'wheelchair'})
        third = json.loads(json.dumps(first))
        third.update({'partition': 'holdout', 'stratum': 'later-time'})
        third['query']['departureSecs'] = 100
        plan['jobs'] = [first, second, third]
        plan['limits']['maxJobs'] = 3
        root = self.fixture.base / 'mixed'
        root.mkdir()
        shutil.copytree(self.fixture.root / 'artifacts', root / 'artifacts')
        fixtures.runner.create_ledger(root / 'pilot.sqlite', plan)
        ledger = fixtures.runner.Ledger(root / 'pilot.sqlite')
        try:
            worker = ledger.acquire('test', 0, 10000)
            first = ledger.claim(worker, 0, 0)
            ledger.complete(first['token'], 'timeout', {'completion': 'timeout', 'elapsedMs': 300})
            retry = ledger.claim(worker, 1, 0)
            ledger.complete(retry['token'], 'error', {'completion': 'error', 'elapsedMs': None})
            ledger.claim(worker, 2, 0)
        finally:
            ledger.close()
        result = report.build_report(root, 3)
        self.assertEqual(result['executionStatus'], 'incomplete')
        self.assertTrue(result['requiresInvestigation'])
        self.assertEqual(result['jobCounts'], {'attempts-exhausted': 1, 'pending': 1, 'not-started': 1})
        self.assertEqual(result['attemptCounts'], {'timeout': 1, 'error': 1, 'pending': 1})
        self.assertEqual(result['cost']['knownAttemptElapsedMsTotal'], 300)
        self.assertEqual(result['cost']['attemptsWithUnknownElapsed'], 2)
        self.assertEqual(len([group for group in result['coverage'] if group['dimension'] == 'partition']), 3)
        self.assertTrue(all(attempt['candidateCount'] is None for job in result['jobs'] for attempt in job['attempts']))
        expired = report.build_report(root, 100000)
        self.assertEqual(expired['jobs'][1]['attempts'][0]['state'], 'expired-pending')

    def test_pending_capture_is_recovery_evidence_not_a_report_side_effect(self):
        self.fixture.initialize()
        with patch.object(fixtures.runner.Ledger, 'complete', side_effect=RuntimeError('staged interruption')):
            with self.assertRaises(RuntimeError):
                fixtures.runner.run_step(self.fixture.root)
        database = self.fixture.root / 'pilot.sqlite'
        before = database.read_bytes()
        pending = report.build_report(self.fixture.root)
        self.assertEqual(pending['jobCounts'], {'pending': 1})
        self.assertTrue(pending['jobs'][0]['attempts'][0]['recoveryCaptureAvailable'])
        self.assertEqual(database.read_bytes(), before)
        fixtures.runner.run_step(self.fixture.root)
        recovered = report.build_report(self.fixture.root)
        self.assertEqual(recovered['jobCounts'], {'verified-empty': 1})
        self.assertEqual(recovered['cost']['attemptsWithUnknownElapsed'], 1)
        self.assertEqual(recovered['cost']['knownAttemptElapsedMsTotal'], 0)

    def test_missing_changed_or_corrupt_evidence_cannot_count_as_verified_success(self):
        self.fixture.initialize()
        result = fixtures.runner.run_step(self.fixture.root)
        path = self.fixture.root / 'runs' / f"{result['captureRunId']}.json"
        original = path.read_bytes()
        path.unlink()
        missing = report.build_report(self.fixture.root)
        self.assertEqual(missing['jobCounts'], {'evidence-invalid': 1})
        self.assertTrue(missing['requiresInvestigation'])
        path.write_bytes(original)
        capture = json.loads(original)
        capture['report']['tuples'][0]['p50Ms'] += 1
        path.write_text(json.dumps(capture))
        changed = report.build_report(self.fixture.root)
        self.assertEqual(changed['evidenceIntegrity'], 'issues-detected')
        self.assertEqual(changed['jobCounts'], {'evidence-invalid': 1})
        path.write_bytes(original)
        original_inspector = report.capture_result
        def replace_after_inspection(*args):
            inspected = original_inspector(*args)
            path.write_text(json.dumps(capture))
            return inspected
        with patch.object(report, 'capture_result', side_effect=replace_after_inspection):
            raced = report.build_report(self.fixture.root)
        self.assertEqual(raced['jobCounts'], {'evidence-invalid': 1})
        self.assertIn('capture changed during report inspection', raced['jobs'][0]['attempts'][0]['evidenceIssues'])
        path.write_bytes(original)
        ledger = fixtures.runner.Ledger(self.fixture.root / 'pilot.sqlite')
        digest = ledger.plan['artifacts']['ptb']
        ledger.close()
        (self.fixture.root / 'artifacts' / digest).write_bytes(b'corrupt')
        corrupted = report.build_report(self.fixture.root)
        self.assertEqual(corrupted['jobCounts'], {'evidence-invalid': 1})
        self.assertTrue(corrupted['snapshotIssues'])

    def test_verified_capture_does_not_imply_feasibility_or_quality(self):
        body = '''return [{legs:[{type:"transit",fromStopId:"A",toStopId:"B",departSecs:0,arriveSecs:-1,
        boardStopIdx:0,alightStopIdx:1,patternStopIds:["A","B"]}],boardSecs:0,alightSecs:-1,transfers:0}];'''
        self.fixture.initialize(body)
        fixtures.runner.run_step(self.fixture.root)
        result = report.build_report(self.fixture.root)
        self.assertEqual(result['jobCounts'], {'verified-candidates': 1})
        self.assertEqual(result['candidateDiagnostics']['candidatesWithFindings'], 1)
        self.assertTrue(result['requiresInvestigation'])
        self.assertIsNone(result['qualityVerdict'])


class CandidateDiagnosticTests(unittest.TestCase):
    def test_chronology_access_occurrences_and_unknown_scope_are_separate(self):
        query = {'departureSecs': 0, 'entryStops': [{'stopId': 'A', 'walkSecs': 10}]}
        ride = {'type': 'transit', 'fromStopId': 'A', 'toStopId': 'B', 'departSecs': 5, 'arriveSecs': 20,
                'boardStopIdx': 0, 'alightStopIdx': 1, 'patternStopIds': ['A', 'B']}
        second = {**ride, 'fromStopId': 'B', 'toStopId': 'C', 'departSecs': 19, 'arriveSecs': 30}
        result = report.inspect_candidate({'legs': [ride, second]}, query)
        codes = {finding['code'] for finding in result['findings']}
        self.assertEqual(codes, {'access-arrives-after-first-departure', 'overlapping-leg-chain', 'occurrence-snapshot-mismatch'})
        del ride['patternStopIds']
        result = report.inspect_candidate({'legs': [{**ride, 'departSecs': 10}]}, query)
        self.assertEqual(result['status'], 'no-findings-in-checked-fields')
        self.assertTrue(result['unchecked'])
        self.assertEqual(report.inspect_candidate({'legs': []}, query)['status'], 'not-evaluated')


if __name__ == '__main__':
    unittest.main()
