#!/usr/bin/env python3
"""Record workload outcomes; skipped or missing gates never count as passed."""
import json
import os
from pathlib import Path
import subprocess

REQUIRED = ('identity', 'wasm', 'parity', 'rss', 'index', 'bundle', 'heap', 'coldstart')


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
    if not report['passed']:
        raise SystemExit('Required regression workload failed, skipped or missing')


if __name__ == '__main__':
    main()
