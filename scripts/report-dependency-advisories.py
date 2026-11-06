#!/usr/bin/env python3
"""Report full-tree npm advisories without converting expected findings into errors."""
import argparse
import json
import os
from pathlib import Path
import subprocess

SEVERITIES = ('critical', 'high', 'moderate', 'low', 'info')


def validate_report(report, returncode):
    if returncode not in (0, 1) or 'error' in report:
        raise ValueError('Dependency audit did not complete successfully')
    counts = report.get('metadata', {}).get('vulnerabilities', {})
    if (not isinstance(report.get('advisories'), dict)
            or any(type(counts.get(key)) is not int or counts[key] < 0 for key in SEVERITIES)):
        raise ValueError('Dependency audit returned an incomplete report')
    # pnpm exits 1 for findings at/above the requested low threshold. A tool
    # failure without corresponding findings must not become a green report.
    if (returncode == 1) != (sum(counts[key] for key in SEVERITIES if key != 'info') > 0):
        raise ValueError('Dependency audit exit status does not match its findings')
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = subprocess.run(['pnpm', 'audit', '--audit-level=low', '--json'], text=True, capture_output=True)
    args.report.write_text(result.stdout)
    if result.stderr:
        print(result.stderr, end='')
    try:
        counts = validate_report(json.loads(result.stdout), result.returncode)
    except (ValueError, TypeError, AttributeError) as error:
        raise SystemExit(f'Audit execution failed; inspect {args.report.name}: {error}') from error
    detail = ', '.join(f'{counts[key]} {key}' for key in SEVERITIES if counts[key]) or '0 findings'
    if sum(counts.values()):
        print(f'::warning::Full dependency-tree audit (advisory): {detail}. Production npm and Rust audits remain blocking.')
    else:
        print('Full dependency-tree audit: no advisories found')
    summary = ('### Full dependency-tree audit (advisory)\n\n'
               f'{detail}. This includes development tooling. Findings do not fail this report; '
               'audit execution errors do. Production npm and Rust audits are separate blocking steps.\n\n'
               'The complete JSON report is attached as `dependency-advisories`.\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as output:
            output.write(summary)


if __name__ == '__main__':
    main()
