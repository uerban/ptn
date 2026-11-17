import importlib.util
import json
from pathlib import Path
import sqlite3
import os
import select
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location('pilot_ledger', Path(__file__).resolve().parents[1] / 'tools/search-pilot/ledger.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def plan():
    return {'format': 'ptn-search-pilot', 'version': 1, 'seed': 'fixed-fixture', 'timezone': 'Europe/Vilnius',
            'artifacts': {'ptb': 'a' * 64, 'glue': 'b' * 64, 'wasm': 'c' * 64},
            'settings': {'objective': 'plan', 'patternMode': 'covering-merge'},
            'limits': {'maxJobs': 2, 'maxAttemptsPerJob': 2, 'attemptTimeoutMs': 100,
                       'totalExecutionMs': 1000, 'maxStorageBytes': 1000000},
            'jobs': [{'query': {'departureSecs': 0}, 'stratum': 'morning', 'partition': 'reported'},
                     {'query': {'departureSecs': 100}, 'stratum': 'holdout-time', 'partition': 'holdout'}]}


class PilotLedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'pilot ? ledger.sqlite'
        pilot.create_ledger(self.path, plan())
        self.ledger = pilot.Ledger(self.path)

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def test_manifest_jobs_attempts_and_results_are_immutable(self):
        with self.assertRaises(FileExistsError):
            pilot.create_ledger(self.path, plan())
        token = self.ledger.acquire('worker', 0, 1000)
        job = self.ledger.claim(token, 0, 0)
        self.ledger.complete(job['token'], 'success', {'completion': 'success', 'candidateCount': 0})
        for table in ('manifest', 'jobs', 'attempts', 'results'):
            for sql in (f'DELETE FROM {table}', f'UPDATE {table} SET rowid=rowid'):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                    self.ledger.db.execute(sql)
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.complete(job['token'], 'timeout', {'completion': 'timeout'})
        self.assertEqual(self.ledger.records()[0]['completion'], 'success')

    def test_restart_preserves_empty_success_and_does_not_repeat_completed_job(self):
        token = self.ledger.acquire('worker', 0, 1000)
        first = self.ledger.claim(token, 0, 0)
        self.ledger.complete(first['token'], 'success', {'completion': 'success', 'candidateCount': 0})
        self.ledger.release(token)
        self.ledger.close()
        self.ledger = pilot.Ledger(self.path)
        other = self.ledger.acquire('resumed', 10, 1000)
        second = self.ledger.claim(other, 10, 0)
        self.assertNotEqual(first['jobId'], second['jobId'])
        self.assertEqual(second['attempt'], 1)
        self.ledger.complete(second['token'], 'success', {'completion': 'success', 'candidateCount': 2})
        self.assertEqual(self.ledger.claim(other, 20, 0, admission_state='storage-budget-exhausted')['state'], 'finished')

    def test_expired_worker_waits_for_bounded_child_and_retains_abandoned_attempt(self):
        old = self.ledger.acquire('old', 0, 10)
        first = self.ledger.claim(old, 0, 20)
        new = self.ledger.acquire('new', 10, 1000)
        self.assertIsNotNone(new)
        self.assertFalse(self.ledger.renew(old, 10, 1000))
        self.assertFalse(self.ledger.release(old))
        with self.assertRaisesRegex(ValueError, 'superseded'):
            self.ledger.claim(old, 10, 0)
        self.assertEqual(self.ledger.claim(new, 119, 0)['state'], 'waiting-for-attempt')
        retry = self.ledger.claim(new, 120, 0)
        self.assertEqual((retry['jobId'], retry['attempt']), (first['jobId'], 2))
        self.assertEqual(self.ledger.records()[0]['completion'], 'abandoned')

    def test_retry_and_execution_reservations_stop_without_claiming_no_route(self):
        token = self.ledger.acquire('worker', 0, 1000)
        first = self.ledger.claim(token, 0, 0)
        self.ledger.complete(first['token'], 'timeout', {'completion': 'timeout'})
        second = self.ledger.claim(token, 1, 0)
        self.assertEqual(second['attempt'], 2)
        self.ledger.complete(second['token'], 'error', {'completion': 'error'})
        third = self.ledger.claim(token, 2, 0)
        self.assertNotEqual(third['jobId'], first['jobId'])
        self.assertEqual([row['completion'] for row in self.ledger.records()][:2], ['timeout', 'error'])
        path = Path(self.directory.name) / 'small.sqlite'
        small = plan()
        small['limits']['totalExecutionMs'] = 99
        pilot.create_ledger(path, small)
        ledger = pilot.Ledger(path)
        try:
            token = ledger.acquire('worker', 0, 1000)
            self.assertEqual(ledger.claim(token, 0, 0)['state'], 'execution-budget-exhausted')
            self.assertEqual(ledger.records(), [])
        finally:
            ledger.close()

    def test_two_connections_cannot_both_acquire_the_worker_lease(self):
        def acquire(owner):
            ledger = pilot.Ledger(self.path)
            try:
                return ledger.acquire(owner, 0, 1000)
            finally:
                ledger.close()
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(acquire, ['one', 'two']))
        self.assertEqual(sum(token is not None for token in results), 1)

    @unittest.skipUnless(os.name == 'posix', 'POSIX process interruption probe')
    def test_killed_process_leaves_committed_claim_recoverable_without_overwrite(self):
        child_code = '''
import importlib.util,sys
spec=importlib.util.spec_from_file_location('ledger',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
ledger=module.Ledger(sys.argv[2])
token=ledger.acquire('interrupted worker',0,10)
claim=ledger.claim(token,0,0)
print(claim['token'],flush=True)
sys.stdin.read()
'''
        child = subprocess.Popen([sys.executable, '-c', child_code, str(Path(pilot.__file__)), str(self.path)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'worker did not commit its claim')
            first_token = child.stdout.readline().strip()
            self.assertTrue(first_token)
            child.kill()
            child.wait(timeout=5)
            self.ledger.close()
            self.ledger = pilot.Ledger(self.path)
            resumed = self.ledger.acquire('resumed worker', 10, 1000)
            self.assertEqual(self.ledger.claim(resumed, 99, 0)['state'], 'waiting-for-attempt')
            retry = self.ledger.claim(resumed, 100, 0)
            self.assertEqual(retry['attempt'], 2)
            records = self.ledger.records()
            self.assertEqual((records[0]['token'], records[0]['completion']), (first_token, 'abandoned'))
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()

    def test_duplicate_or_malformed_jobs_and_mismatched_outcomes_reject(self):
        duplicate = plan()
        duplicate['jobs'][1]['query'] = duplicate['jobs'][0]['query']
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            pilot.validate_plan(duplicate)
        malformed = plan()
        malformed['jobs'][0]['query']['departureSecs'] = float('nan')
        with self.assertRaises(ValueError):
            pilot.validate_plan(malformed)
        for field in plan()['limits']:
            invalid = plan()
            invalid['limits'][field] = True
            with self.subTest(field=field), self.assertRaises(ValueError):
                pilot.validate_plan(invalid)
        token = self.ledger.acquire('worker', 0, 1000)
        job = self.ledger.claim(token, 0, 0)
        with self.assertRaisesRegex(ValueError, 'must match'):
            self.ledger.complete(job['token'], 'success', {'completion': 'timeout'})

    def test_backoff_is_durable_exponential_and_does_not_starve_fresh_jobs(self):
        config = plan()
        config['limits'].update({'retryBackoffMs': 100, 'maxAttemptsPerJob': 3})
        path = Path(self.directory.name) / 'backoff.sqlite'
        pilot.create_ledger(path, config)
        ledger = pilot.Ledger(path)
        try:
            worker = ledger.acquire('worker', 0, 10000)
            failed = ledger.claim(worker, 0, 0)
            ledger.complete(failed['token'], 'error', {'completion': 'error'}, recorded_at_ms=10)
            fresh = ledger.claim(worker, 20, 0)
            self.assertNotEqual(fresh['jobId'], failed['jobId'])
            ledger.complete(fresh['token'], 'success', {'completion': 'success'}, recorded_at_ms=21)
            ledger.release(worker)
            ledger.close()
            ledger = pilot.Ledger(path)
            worker = ledger.acquire('resumed', 100, 10000)
            before = ledger.records()
            self.assertEqual(ledger.claim(worker, 109, 0), {'state': 'retry-backoff', 'retryAtMs': 110, 'retryAfterMs': 1})
            self.assertEqual(ledger.records(), before)
            retry = ledger.claim(worker, 110, 0)
            self.assertEqual(retry['attempt'], 2)
            ledger.complete(retry['token'], 'timeout', {'completion': 'timeout'}, recorded_at_ms=120)
            self.assertEqual(ledger.claim(worker, 319, 0)['retryAtMs'], 320)
            final = ledger.claim(worker, 320, 0)
            self.assertEqual(final['attempt'], 3)
            ledger.complete(final['token'], 'error', {'completion': 'error'}, recorded_at_ms=330)
            self.assertEqual(ledger.claim(worker, 330, 0)['state'], 'finished')
            self.assertEqual(len(ledger.records()), 4)
        finally:
            ledger.close()

    def test_abandoned_attempt_backoff_uses_recorded_observation_without_fake_completion(self):
        config = plan()
        config['limits']['retryBackoffMs'] = 100
        path = Path(self.directory.name) / 'abandoned-backoff.sqlite'
        pilot.create_ledger(path, config)
        ledger = pilot.Ledger(path)
        try:
            old = ledger.acquire('old', 0, 10)
            first = ledger.claim(old, 0, 0)
            new = ledger.acquire('new', 10, 10000)
            fresh = ledger.claim(new, 100, 0)
            self.assertNotEqual(first['jobId'], fresh['jobId'])
            evidence = json.loads(ledger.records()[0]['result'])
            self.assertEqual(evidence['observedAtMs'], 100)
            self.assertNotIn('recordedAtMs', evidence)
            ledger.complete(fresh['token'], 'success', {'completion': 'success'}, recorded_at_ms=101)
            self.assertEqual(ledger.claim(new, 199, 0)['retryAtMs'], 200)
            self.assertEqual(ledger.claim(new, 200, 0)['attempt'], 2)
        finally:
            ledger.close()

    def test_backoff_caps_and_optional_legacy_policy_are_explicit(self):
        attempt = {'number': 1, 'expires_ms': 100}
        result = {'completion': 'error', 'recordedAtMs': 10}
        self.assertIsNone(pilot.retry_not_before(attempt, result, {}))
        self.assertEqual(pilot.retry_not_before(attempt, result, {'retryBackoffMs': 40000}), 40010)
        self.assertEqual(pilot.retry_not_before({**attempt, 'number': 2}, result, {'retryBackoffMs': 40000}), 60010)
        self.assertEqual(pilot.retry_not_before({**attempt, 'number': 1000000000}, result, {'retryBackoffMs': 1}), 60010)
        for value in (-1, True, 1.5, 60001):
            invalid = plan()
            invalid['limits']['retryBackoffMs'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                pilot.validate_plan(invalid)


if __name__ == '__main__':
    unittest.main()
