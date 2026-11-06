import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import io
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location('report', Path(__file__).with_name('report-dependency-advisories.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class DependencyReportTests(unittest.TestCase):
    def payload(self, high=0, critical=0, moderate=0):
        return {'advisories': {}, 'metadata': {'vulnerabilities': {
            'critical': critical, 'high': high, 'moderate': moderate, 'low': 0, 'info': 0}}}

    def test_high_critical_and_below_threshold_findings_are_advisory(self):
        self.assertEqual(report.validate_report(self.payload(high=8, critical=1), 1)['critical'], 1)
        self.assertEqual(report.validate_report(self.payload(moderate=2), 1)['moderate'], 2)
        self.assertEqual(report.validate_report(self.payload(), 0)['high'], 0)

    def test_failed_or_incomplete_audit_does_not_pass(self):
        for payload, status in [({'error': {'code': 'ECONNRESET'}}, 1), ({}, 0),
                                (self.payload(), 2), (self.payload(), 1), (self.payload(high=1), 0)]:
            with self.subTest(payload=payload, status=status), self.assertRaises(ValueError):
                report.validate_report(payload, status)

    def test_invalid_counts_do_not_pass(self):
        for value in (-1, True, '8', None):
            payload = self.payload()
            payload['metadata']['vulnerabilities']['high'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                report.validate_report(payload, 0)

    def test_findings_emit_warning_summary_and_retained_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = json.dumps(self.payload(high=8, critical=1))
            result = subprocess.CompletedProcess([], 1, payload, '')
            with patch.object(report.subprocess, 'run', return_value=result), \
                    patch('sys.argv', ['report', '--report', str(root / 'audit.json')]), \
                    patch.dict('os.environ', GITHUB_STEP_SUMMARY=str(root / 'summary.md')), \
                    redirect_stdout(io.StringIO()) as output:
                report.main()
            self.assertIn('::warning::', output.getvalue())
            self.assertNotIn('::error::', output.getvalue())
            self.assertIn('1 critical', (root / 'summary.md').read_text())
            self.assertEqual((root / 'audit.json').read_text(), payload)

    def test_non_json_scanner_failure_is_a_real_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.CompletedProcess([], 1, 'registry unavailable', '')
            with patch.object(report.subprocess, 'run', return_value=result), \
                    patch('sys.argv', ['report', '--report', str(Path(directory) / 'audit.json')]):
                with self.assertRaisesRegex(SystemExit, 'Audit execution failed'):
                    report.main()


if __name__ == '__main__':
    unittest.main()
