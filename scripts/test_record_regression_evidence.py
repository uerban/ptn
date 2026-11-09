import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'regression', Path(__file__).with_name('record-regression-evidence.py'))
regression = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regression)


class RegressionReportTests(unittest.TestCase):
    def test_summary_and_evidence_survive_unsuccessful_gates(self):
        for outcome in ('success', 'failure', 'skipped', 'cancelled', 'missing', 'dirty'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                steps = {name: {'outcome': 'success'} for name in regression.LABELS}
                if outcome == 'missing':
                    del steps['heap']
                elif outcome not in ('success', 'dirty'):
                    steps['heap']['outcome'] = outcome
                summary = Path(directory) / 'summary.md'
                previous = Path.cwd()
                try:
                    os.chdir(directory)
                    with patch.dict(os.environ, {
                        'STEP_RESULTS': json.dumps(steps),
                        'GITHUB_STEP_SUMMARY': str(summary),
                    }), patch.object(regression.subprocess, 'check_output', return_value='a' * 40), \
                         patch.object(regression.subprocess, 'run') as run:
                        run.return_value.returncode = int(outcome == 'dirty')
                        if outcome == 'success':
                            regression.main([])
                        else:
                            with self.assertRaises(SystemExit):
                                regression.main([])
                    report = json.loads(Path('evidence/regression.json').read_text())
                    self.assertEqual(report['passed'], outcome == 'success')
                    content = summary.read_text()
                    self.assertEqual(content, Path('evidence/regression.md').read_text())
                    self.assertIn('PASSED' if report['passed'] else 'FAILED', content)
                    self.assertIn('a' * 40, content)
                    self.assertIn('regression-proof', content)
                    self.assertIn('regression-evidence', content)
                    self.assertIn('| Browser JS heap budget | ' +
                                  ('success' if outcome == 'dirty' else outcome) + ' |', content)
                finally:
                    os.chdir(previous)


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.baseline = Path(self.directory.name) / 'baseline.json'
        patcher = patch.object(regression, 'BASELINE', self.baseline)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_report(self, passed, run='7', heap=20.0):
        path = Path(self.directory.name) / f'regression-{run}.json'
        path.write_text(json.dumps({'passed': passed, 'revision': 'b' * 40, 'runId': run, 'measurements': [
            {'gate': 'heap', 'name': 'JS heap after load', 'value': heap, 'unit': 'MB', 'budget': 100},
            {'gate': 'cityswitch', 'name': 'pan all z14 long-task count', 'value': 0, 'unit': 'tasks', 'budget': None},
        ]}))
        return path

    def test_update_baseline_refuses_failed_runs(self):
        with self.assertRaises(SystemExit):
            regression.main(['--update-baseline', str(self.write_report(False))])
        self.assertFalse(self.baseline.exists())

    def test_update_rejects_unknown_arguments(self):
        with self.assertRaises(SystemExit):
            regression.main(['--baseline'])

    def test_update_baseline_stores_passing_measurements(self):
        regression.main(['--update-baseline', str(self.write_report(True))])
        stored = json.loads(self.baseline.read_text())
        self.assertEqual(stored['revision'], 'b' * 40)
        self.assertEqual(stored['runIds'], ['7'])
        self.assertEqual(stored['measurements'], {
            'heap/JS heap after load': {'value': 20.0, 'unit': 'MB', 'samples': 1},
            'cityswitch/pan all z14 long-task count': {'value': 0, 'unit': 'tasks', 'samples': 1},
        })

    def test_update_baseline_takes_median_of_runs(self):
        paths = [str(self.write_report(True, run, heap)) for run, heap in (('1', 30.0), ('2', 10.0), ('3', 22.0))]
        regression.main(['--update-baseline', *paths])
        stored = json.loads(self.baseline.read_text())
        self.assertEqual(stored['runIds'], ['1', '2', '3'])
        self.assertEqual(stored['measurements']['heap/JS heap after load'], {'value': 22.0, 'unit': 'MB', 'samples': 3})

    def test_update_baseline_refuses_any_failed_run(self):
        with self.assertRaises(SystemExit):
            regression.main(['--update-baseline', str(self.write_report(True, '1')), str(self.write_report(False, '2'))])
        self.assertFalse(self.baseline.exists())

    def test_notable_needs_percent_and_absolute_floor(self):
        baseline = {'measurements': {
            'g/tiny': {'value': 2, 'unit': 'ms'},
            'g/slow': {'value': 200, 'unit': 'ms'},
            'g/small': {'value': 100, 'unit': 'ms'},
            'g/cards': {'value': 20, 'unit': 'cards'},
        }}
        rows = regression.compare_baseline([
            {'gate': 'g', 'name': 'tiny', 'value': 5, 'unit': 'ms'},
            {'gate': 'g', 'name': 'slow', 'value': 250, 'unit': 'ms'},
            {'gate': 'g', 'name': 'small', 'value': 110, 'unit': 'ms'},
            {'gate': 'g', 'name': 'cards', 'value': 10, 'unit': 'cards'},
        ], baseline)
        self.assertEqual([row['notable'] for row in rows], [False, True, False, True])

    def test_compare_reports_change_and_skips_unusable_baselines(self):
        baseline = {'measurements': {
            'heap/grew': {'value': 20, 'unit': 'MB'},
            'heap/zero': {'value': 0, 'unit': 'tasks'},
            'heap/unit': {'value': 5, 'unit': 'ms'},
        }}
        rows = regression.compare_baseline([
            {'gate': 'heap', 'name': 'grew', 'value': 25, 'unit': 'MB'},
            {'gate': 'heap', 'name': 'zero', 'value': 3, 'unit': 'tasks'},
            {'gate': 'heap', 'name': 'unit', 'value': 5, 'unit': 'bytes'},
            {'gate': 'heap', 'name': 'new', 'value': 1, 'unit': 'MB'},
        ], baseline)
        self.assertEqual((rows[0]['baseline'], rows[0]['deltaPercent']), (20, 25.0))
        self.assertEqual(rows[1]['baseline'], 0)
        self.assertNotIn('deltaPercent', rows[1])
        self.assertIsNone(rows[2]['baseline'])
        self.assertIsNone(rows[3]['baseline'])

    def test_summary_shows_baseline_and_pan_counts(self):
        self.baseline.write_text(json.dumps({'revision': 'c' * 40, 'runIds': ['8', '9'], 'measurements': {
            'cityswitch/viewport all cards z16 stop cards': {'value': 20, 'unit': 'cards'}}}))
        previous = Path.cwd()
        try:
            os.chdir(self.directory.name)
            Path('evidence').mkdir()
            Path('evidence/viewport-pan.json').write_text(json.dumps({'runs': [
                {'mode': 'all', 'level': 'cards', 'zoom': 16, 'dots': 40, 'settleMs': 31.5, 'frameIntervalMs': {'p95': 9}, 'longTaskMs': {'samples': 2},
                 'longTaskTotalMs': 120, 'labels': 0, 'cards': 18}]}))
            steps = {name: {'outcome': 'success'} for name in regression.LABELS}
            # CI exports GITHUB_STEP_SUMMARY to every process, including tests.
            # Keep this fixture's fake revisions out of the real run summary.
            with patch.dict(os.environ, {
                    'STEP_RESULTS': json.dumps(steps),
                    'GITHUB_STEP_SUMMARY': str(Path(self.directory.name) / 'summary.md'),
            }), \
                 patch.object(regression.subprocess, 'check_output', return_value='a' * 40), \
                 patch.object(regression.subprocess, 'run') as run:
                run.return_value.returncode = 0
                regression.main([])
            report = json.loads(Path('evidence/regression.json').read_text())
            content = Path('evidence/regression.md').read_text()
        finally:
            os.chdir(previous)
        self.assertEqual(report['baseline'], {'revision': 'c' * 40, 'runIds': ['8', '9']})
        self.assertIn('Baseline: median of runs 8, 9 at `cccccccccccc`', content)
        self.assertIn('Notable changes (⚠, at least 15% and above the absolute floor 20 ms, 5 MB): 0', content)
        self.assertIn('| cityswitch | viewport all cards z16 long-task count | 2 tasks | — | — | recorded only |', content)
        self.assertIn('| cityswitch | viewport all cards z16 long-task total | 120 ms | — | — | recorded only |', content)
        self.assertIn('| cityswitch | viewport all cards z16 settle after last move | 31.5 ms | — | — | recorded only |', content)
        self.assertIn('| cityswitch | viewport all cards z16 stop dots | 40 dots | — | — | recorded only |', content)
        self.assertIn('| cityswitch | viewport all cards z16 stop cards | 18 cards | 20 cards | -10.0% | recorded only |', content)


if __name__ == '__main__':
    unittest.main()
