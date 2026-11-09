#!/usr/bin/env python3
"""Record workload outcomes; skipped or missing gates never count as passed."""
import json
import os
from pathlib import Path
import subprocess
import sys

BASELINE = Path(__file__).resolve().parent / 'regression' / 'baseline.json'

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
        add('cityswitch', f"pan {run.get('mode')} z{run.get('zoom')} long-task count", (run.get('longTaskMs') or {}).get('samples'), 'tasks')
        add('cityswitch', f"pan {run.get('mode')} z{run.get('zoom')} long-task total", run.get('longTaskTotalMs'), 'ms')
    return rows


def baseline_key(row):
    return f"{row['gate']}/{row['name']}"


def load_baseline():
    try:
        return json.loads(BASELINE.read_text())
    except (OSError, ValueError):
        return {'measurements': {}}


def compare_baseline(rows, baseline):
    """Attach the recorded baseline and relative change; informational only."""
    known = baseline.get('measurements') or {}
    for row in rows:
        base = known.get(baseline_key(row))
        row['baseline'] = base['value'] if base and base.get('unit') == row['unit'] else None
        if row['baseline']:
            row['deltaPercent'] = round((row['value'] - row['baseline']) / row['baseline'] * 100, 1)
    return rows


def update_baseline(report_path):
    """Promote a regression.json from a passing run to the stored baseline."""
    report = json.loads(Path(report_path).read_text())
    if not report.get('passed'):
        raise SystemExit(f'{report_path}: only a passing run can become the baseline')
    baseline = {'schemaVersion': 1, 'revision': report['revision'], 'runId': report.get('runId'),
                'measurements': {baseline_key(row): {'value': row['value'], 'unit': row['unit']}
                                 for row in report['measurements']}}
    BASELINE.write_text(json.dumps(baseline, indent=2) + '\n')
    print(f"{BASELINE}: {len(baseline['measurements'])} measurements from run {baseline['runId']}")


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
        base = report.get('baseline') or {}
        lines += ['', '### Measurements', '',
                  f"Baseline: run {base.get('runId') or 'none'} at `{(base.get('revision') or 'none')[:12]}` "
                  '(changes are informational; only budgets fail the gate).', '',
                  '| Gate | Measurement | Value | Baseline | Change | Budget |',
                  '| --- | --- | ---: | ---: | ---: | ---: |']
        for row in report['measurements']:
            budget = 'recorded only' if row['budget'] is None else f"{row['budget']} {row['unit']}"
            baseline = '—' if row.get('baseline') is None else f"{row['baseline']} {row['unit']}"
            delta = '—' if row.get('deltaPercent') is None else f"{row['deltaPercent']:+}%"
            lines.append(f"| {row['gate']} | {row['name']} | {row['value']} {row['unit']} | {baseline} | {delta} | {budget} |")
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
    if sys.argv[1:2] == ['--update-baseline'] and len(sys.argv) == 3:
        update_baseline(sys.argv[2])
        return
    baseline = load_baseline()
    steps = json.loads(os.environ['STEP_RESULTS'])
    checks = {name: steps.get(name, {}).get('outcome', 'missing') for name in REQUIRED}
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.run(['git', 'diff', '--quiet', 'HEAD']).returncode != 0
    report = {'schemaVersion': 1, 'revision': revision, 'sourceDirty': dirty, 'checks': checks,
              'passed': not dirty and all(value == 'success' for value in checks.values()),
              'runner': os.environ.get('RUNNER_OS'), 'runId': os.environ.get('GITHUB_RUN_ID'),
              'measurements': compare_baseline(collect_measurements(), baseline),
              'baseline': {'revision': baseline.get('revision'), 'runId': baseline.get('runId')}}
    Path('evidence').mkdir(exist_ok=True)
    Path('evidence/regression.json').write_text(json.dumps(report, indent=2) + '\n')
    write_summary(report, steps)
    if not report['passed']:
        raise SystemExit('Required regression workload failed, skipped or missing')


if __name__ == '__main__':
    main()
