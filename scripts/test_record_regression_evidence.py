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
                            regression.main()
                        else:
                            with self.assertRaises(SystemExit):
                                regression.main()
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


if __name__ == '__main__':
    unittest.main()
