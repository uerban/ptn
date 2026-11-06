#!/usr/bin/env python3
"""Record workload outcomes; skipped or missing gates never count as passed."""
import json
import os
from pathlib import Path
import subprocess

REQUIRED = ('identity', 'wasm', 'parity', 'rss', 'index', 'bundle', 'heap', 'coldstart')
LABELS = {
    'identity': 'Exact source revision',
    'build': 'Browser bindings and native reference build',
    'wasm': 'WASM imports and compressed size',
    'parity': 'Routing goldens and binding parity',
    'rss': 'Native RSS admission safeguards',
    'index': 'Index-build p99 budget',
    'bundle': 'Browser bundle size',
    'browser': 'Chromium installation',
    'measurement': 'Browser measurement hooks build',
    'heap': 'Browser JS heap budget',
    'coldstart': 'WASM cold-start p95 budgets',
}


def write_summary(report, steps):
    lines = ['## Regression gates', '',
             '**Result: ' + ('PASSED' if report['passed'] else 'FAILED') + '**', '',
             f"Source revision: `{report['revision']}`", '',
             'Tracked source changes: ' + ('present' if report['sourceDirty'] else 'none'), '',
             '| Gate / prerequisite | Outcome |', '| --- | --- |']
    for name, label in LABELS.items():
        outcome = steps.get(name, {}).get('outcome', 'missing')
        lines.append(f'| {label} | {outcome} |')
    lines += ['', 'Failed, cancelled, skipped or missing required gates do not count as passed.', '',
              'Download **regression-proof** for `regression.json` and '
              '**regression-evidence** for measurements, benchmark results and browser test output '
              'from this workflow run’s Artifacts section (30-day retention).', '']
    summary = '\n'.join(lines)
    Path('evidence/regression.md').write_text(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write(summary)


def main():
    steps = json.loads(os.environ['STEP_RESULTS'])
    checks = {name: steps.get(name, {}).get('outcome', 'missing') for name in REQUIRED}
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.run(['git', 'diff', '--quiet', 'HEAD']).returncode != 0
    report = {'schemaVersion': 1, 'revision': revision, 'sourceDirty': dirty, 'checks': checks,
              'passed': not dirty and all(value == 'success' for value in checks.values()),
              'runner': os.environ.get('RUNNER_OS'), 'runId': os.environ.get('GITHUB_RUN_ID')}
    Path('evidence').mkdir(exist_ok=True)
    Path('evidence/regression.json').write_text(json.dumps(report, indent=2) + '\n')
    write_summary(report, steps)
    if not report['passed']:
        raise SystemExit('Required regression workload failed, skipped or missing')


if __name__ == '__main__':
    main()
