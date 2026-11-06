import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const benchmarkChecker = resolve('packages/frontend/scripts/check-bench-budgets.mjs');
function budgetResult(benchmarks) {
  const cwd = mkdtempSync(join(tmpdir(), 'ptn-bench-policy-'));
  try {
    mkdirSync(join(cwd, 'tests/benchmarks'), {recursive: true});
    writeFileSync(join(cwd, 'tests/benchmarks/.results.json'), JSON.stringify({files: [{groups: [{benchmarks}]}]}));
    return spawnSync(process.execPath, [benchmarkChecker], {cwd, encoding: 'utf8'});
  } finally {rmSync(cwd, {recursive: true, force: true});}
}
const row = {name: 'hydrate patterns-ON index at pattern-fanout scale', p99: 60};
test('index budget accepts a finite in-budget workload', () => assert.equal(budgetResult([row]).status, 0));
test('index budget fails for slow, missing, nonnumeric or duplicated measurements', () => {
  for (const rows of [[{...row, p99: 76}], [], [{...row, p99: null}], [row, row]]) {
    assert.notEqual(budgetResult(rows).status, 0);
  }
});
test('a browser report with only skipped tests cannot satisfy the gate', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ptn-browser-policy-'));
  try {
    const path = join(cwd, 'report.json');
    writeFileSync(path, JSON.stringify({stats: {expected: 0, unexpected: 0}, suites: []}));
    const result = spawnSync(process.execPath, ['scripts/check-browser-regressions.mjs', path, 'heap']);
    assert.notEqual(result.status, 0);
  } finally {rmSync(cwd, {recursive: true, force: true});}
});
