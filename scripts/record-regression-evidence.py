#!/usr/bin/env python3
"""Record workload outcomes; skipped or missing gates never count as passed."""
import json
import os
from pathlib import Path
import subprocess

REQUIRED = ('identity', 'wasm', 'parity', 'rss', 'index', 'bundle', 'heap', 'coldstart', 'cityswitch')
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
    'cities': 'Synthetic two-city serving',
    'cityswitch': 'City switch and viewport pan workloads',
}


def load(name):
    try:
        return json.loads((Path('evidence') / name).read_text())
    except (OSError, ValueError):
        return None


def collect_measurements():
    """Key measured values with their budgets; budget None means recorded only."""
    rows = []

    def add(gate, name, value, unit, budget=None):
        if isinstance(value, (int, float)):
            rows.append({'gate': gate, 'name': name, 'value': round(value, 2), 'unit': unit, 'budget': budget})

    wasm = load('wasm.json')
    if wasm:
        add('wasm', 'WASM gzip size', wasm.get('gzipBytes'), 'bytes', wasm.get('budget'))
        add('wasm', 'WASM raw size', wasm.get('rawBytes'), 'bytes')
    for row in load('index-bench.json') or []:
        add('index', f"{row.get('name')} {row.get('metric')}", row.get('valueMs'), 'ms', row.get('budgetMs'))
    for row in load('bundle.json') or []:
        add('bundle', row.get('name'), row.get('size'), 'bytes', row.get('sizeLimit'))
    heap = load('heap.json')
    if heap:
        add('heap', 'JS heap after load', heap.get('value'), 'MB', heap.get('budget'))
    for profile in ('fast', 'throttled'):
        cold = load(f'wasm-coldstart-{profile}.json')
        for stage, value in ((cold or {}).get('p95') or {}).items():
            add('coldstart', f'{profile} {stage} p95', value, 'ms', (cold.get('budgets') or {}).get(stage))
    switch = load('city-switch.json')
    for city, stats in ((switch or {}).get('cities') or {}).items():
        for metric, label in (('indexMs', 'index ready'), ('activityMs', 'badges resolved'), ('lastCardChangeMs', 'cards settled')):
            add('cityswitch', f'{city} {label} p95', (stats.get(metric) or {}).get('p95'), 'ms')
    pan = load('viewport-pan.json')
    for run in (pan or {}).get('runs') or []:
        add('cityswitch', f"pan {run.get('mode')} z{run.get('zoom')} frame p95", (run.get('frameIntervalMs') or {}).get('p95'), 'ms')
        add('cityswitch', f"pan {run.get('mode')} z{run.get('zoom')} long tasks", run.get('longTaskTotalMs'), 'ms')
    return rows


def write_summary(report, steps):
    lines = ['## Regression gates', '',
             '**Result: ' + ('PASSED' if report['passed'] else 'FAILED') + '**', '',
             f"Source revision: `{report['revision']}`", '',
             'Tracked source changes: ' + ('present' if report['sourceDirty'] else 'none'), '',
             '| Gate / prerequisite | Outcome |', '| --- | --- |']
    for name, label in LABELS.items():
        outcome = steps.get(name, {}).get('outcome', 'missing')
        lines.append(f'| {label} | {outcome} |')
    if report['measurements']:
        lines += ['', '### Measurements', '', '| Gate | Measurement | Value | Budget |', '| --- | --- | ---: | ---: |']
        for row in report['measurements']:
            budget = 'recorded only' if row['budget'] is None else f"{row['budget']} {row['unit']}"
            lines.append(f"| {row['gate']} | {row['name']} | {row['value']} {row['unit']} | {budget} |")
        lines += ['', 'Routing parity and native RSS checks are pass/fail; their logs are in the evidence.']
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
              'runner': os.environ.get('RUNNER_OS'), 'runId': os.environ.get('GITHUB_RUN_ID'),
              'measurements': collect_measurements()}
    Path('evidence').mkdir(exist_ok=True)
    Path('evidence/regression.json').write_text(json.dumps(report, indent=2) + '\n')
    write_summary(report, steps)
    if not report['passed']:
        raise SystemExit('Required regression workload failed, skipped or missing')


if __name__ == '__main__':
    main()
