import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

HERE = Path(__file__).resolve().parents[1] / 'tools/search-pilot'
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('pilot_sample', HERE / 'sample.py')
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)


class PilotSamplingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / 'artifacts').mkdir()
        (self.root / 'runs').mkdir()
        self.universe = {'format': 'ptn-search-stop-universe', 'version': 1, 'ptbSha256': sample.sha(b'ptb'),
                         'stops': [{'stopId': name, 'latE7': coordinate, 'lonE7': coordinate}
                                   for name, coordinate in [('C', 15000000), ('A', 5000000), ('D', 30000000), ('B', 10000000)]]}
        self.stratum = {'id': 'weekday', 'date': '20261113', 'departureSecs': 21600, 'mobilityProfile': 'default',
                        'maxRounds': 4, 'random': 1, 'holdout': 1}
        self.config = {'format': 'ptn-search-sampling-spec', 'version': 1, 'seed': 'fixed', 'timezone': 'Europe/Vilnius',
                       'bounds': {'south': 0, 'west': 0, 'north': 2, 'east': 2}, 'reportedTupleIndices': [0],
                       'settings': {'objective': 'plan', 'patternMode': 'covering-merge', 'glueExecution': 'snapshot', 'iterations': 2, 'warmup': 0},
                       'limits': {'maxJobs': 10, 'maxAttemptsPerJob': 1, 'attemptTimeoutMs': 1000, 'totalExecutionMs': 30000,
                                  'maxStorageBytes': 32000000, 'attemptFileBytes': 65536, 'retryBackoffMs': 1000},
                       'strata': [self.stratum, {**self.stratum, 'id': 'weekend-wheelchair', 'date': '20261114', 'mobilityProfile': 'wheelchair'}]}

    def tearDown(self):
        self.directory.cleanup()

    def store(self):
        values = {'ptb': b'ptb', 'glue': b'glue', 'wasm': b'wasm', 'samplingStopUniverse': json.dumps(self.universe).encode(),
                  'samplingSpec': json.dumps(self.config).encode(), 'samplingGeneratorSource': Path(sample.__file__).read_bytes(),
                  'samplingGeneratorLedger': Path(sample.ledger.__file__).read_bytes()}
        hashes = {}
        for name, value in values.items():
            digest = sample.sha(value)
            (self.root / 'artifacts' / digest).write_bytes(value)
            hashes[name] = digest
        record = {'schemaVersion': 1, 'completion': 'success', 'artifacts': hashes,
                  'report': {'tuples': [{'query': sample.query_for('A', 'B', self.stratum)}]}}
        (self.root / 'runs/source.json').write_text(json.dumps(record))
        return hashes

    def test_deterministic_population_bounded_unique_partitions_and_private_no_overwrite_export(self):
        self.store()
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('sampling must not execute planners')):
            first = sample.materialize_plan(self.root, 'source')
            self.assertEqual(first, sample.materialize_plan(self.root, 'source'))
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.assertEqual(len(first['jobs']), 5)
        self.assertEqual(first['sampling']['insideRectangleStops'], 3)
        self.assertEqual(first['sampling']['compiledStops'], 4)
        self.assertEqual(first['sampling']['strata'][0]['excludedExactQueries'], 1)
        keys = [sample.canonical(job['query']) for job in first['jobs']]
        self.assertEqual(len(set(keys)), len(keys))
        for job in first['jobs']:
            query = job['query']
            self.assertNotEqual(query['entryStops'][0]['stopId'], query['exitStops'][0]['stopId'])
            self.assertNotIn('D', [query['entryStops'][0]['stopId'], query['exitStops'][0]['stopId']])
        output = self.root / 'plan.json'
        command = [sys.executable, str(HERE / 'sample.py'), str(self.root), 'source', str(output)]
        subprocess.run(command, check=True, capture_output=True)
        content = output.read_bytes()
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual(output.read_bytes(), content)

    def test_population_order_and_holdout_count_do_not_reshuffle_random_queries(self):
        self.store()
        original = sample.materialize_plan(self.root, 'source')
        self.universe['stops'].reverse()
        self.stratum['holdout'] = 2
        self.store()
        changed = sample.materialize_plan(self.root, 'source')
        self.assertEqual([job for job in original['jobs'] if job['partition'] == 'random'],
                         [job for job in changed['jobs'] if job['partition'] == 'random'])
        self.assertEqual(original['sampling']['populationStopIdsSha256'], changed['sampling']['populationStopIdsSha256'])

    def test_dense_sampling_uses_remaining_ranks_without_building_a_cartesian_product(self):
        self.config['strata'] = [self.stratum]
        self.stratum.update({'random': 2, 'holdout': 3})
        self.store()
        plan = sample.materialize_plan(self.root, 'source')
        self.assertEqual(len(plan['jobs']), 6)
        pairs = {(job['query']['entryStops'][0]['stopId'], job['query']['exitStops'][0]['stopId']) for job in plan['jobs']}
        self.assertEqual(pairs, {(a, b) for a in 'ABC' for b in 'ABC' if a != b})
        self.stratum['holdout'] = 4
        self.store()
        with self.assertRaisesRegex(ValueError, 'eligible population'):
            sample.materialize_plan(self.root, 'source')

    def test_bad_bounds_strata_profiles_and_duplicate_ids_fail_instead_of_truncating(self):
        self.store()
        original = json.loads(json.dumps(self.config))
        for change in [lambda: self.config['bounds'].update({'east': -1}),
                       lambda: self.stratum.update({'date': '20261199'}),
                       lambda: self.stratum.update({'mobilityProfile': 'unknown'}),
                       lambda: self.stratum.update({'random': True}),
                       lambda: self.config['strata'].append({**self.stratum, 'id': 'same-query'})]:
            self.config = json.loads(json.dumps(original))
            self.stratum = self.config['strata'][0]
            change()
            self.store()
            with self.assertRaises(ValueError):
                sample.materialize_plan(self.root, 'source')
        self.config = original
        self.universe['stops'].append(self.universe['stops'][0])
        self.store()
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            sample.materialize_plan(self.root, 'source')

    def test_wrong_ptb_corrupt_artifacts_and_generator_mismatch_reject(self):
        self.universe['ptbSha256'] = '0' * 64
        self.store()
        with self.assertRaisesRegex(ValueError, 'another PTB'):
            sample.materialize_plan(self.root, 'source')
        self.universe['ptbSha256'] = sample.sha(b'ptb')
        hashes = self.store()
        (self.root / 'artifacts' / hashes['glue']).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            sample.materialize_plan(self.root, 'source')
        self.store()
        record = json.loads((self.root / 'runs/source.json').read_text())
        record['artifacts']['samplingGeneratorSource'] = hashes['glue']
        (self.root / 'runs/source.json').write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'generator source mismatch'):
            sample.materialize_plan(self.root, 'source')

    def test_draw_rejects_modulo_bias_and_is_seeded(self):
        draws = sample.Draws({'seed': 'fixed'})
        with patch.object(sample.hashlib, 'sha256', side_effect=[Mock(digest=lambda: b'\xff' * 32), Mock(digest=lambda: bytes(32))]):
            self.assertEqual(draws.below(3), 0)
        self.assertEqual(draws.counter, 2)
        a, b = sample.Draws('fixed'), sample.Draws('fixed')
        self.assertEqual([a.below(100) for _ in range(20)], [b.below(100) for _ in range(20)])


if __name__ == '__main__':
    unittest.main()
