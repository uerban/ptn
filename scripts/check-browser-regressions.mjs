import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const [path, ...requiredTitles] = process.argv.slice(2);
const report = JSON.parse(readFileSync(path));
assert(report.stats.expected > 0 && report.stats.unexpected === 0, 'browser gate failed or ran no passing tests');
const passed = [];
function visit(suite) {
  for (const spec of suite.specs ?? []) {
    if (spec.tests.some(test => test.status === 'expected' && test.results.some(result => result.status === 'passed'))) passed.push(spec.title);
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);
for (const title of requiredTitles) assert(passed.some(value => value.includes(title)), `required browser workload did not pass: ${title}`);
console.log(`Browser gate: ${passed.length} passing workloads, all required titles present`);
