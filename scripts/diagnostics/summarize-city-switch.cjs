// Summarize the bounded city-switch probe without publishing raw stop/location data.
// node scripts/diagnostics/summarize-city-switch.cjs /tmp/probe-output [summary.json]
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv[2];
if (!directory) throw new Error('Expected probe output directory');
const samples = JSON.parse(fs.readFileSync(path.join(directory, 'repeated.json'), 'utf8'));
const capture = JSON.parse(fs.readFileSync(path.join(directory, 'live.json'), 'utf8'));
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
};
const distribution = values => ({p50: quantile(values, .5), p95: quantile(values, .95), max: values.length ? Math.max(...values) : null});
const cities = {};
const cityIds = capture.citySequence ?? ['vilnius', 'krakow'];
for (const cityId of cityIds) {
  const rows = samples.filter(row => row.cityId === cityId);
  const tail = rows.slice(-20).map(row => row.heap.usedSize);
  cities[cityId] = {
    samples: rows.length,
    indexMs: distribution(rows.map(row => row.readyMs)),
    authoritativeActivityMs: distribution(rows.map(row => row.activityReadyMs)),
    lastCardChangeMs: distribution(rows.map(row => row.lastCardChangeMs)),
    allActivityComplete: rows.length > 0 && rows.every(row => row.activity?.outcome === 'complete' && row.activity.ready === row.activity.requested),
    allStabilityWindowsConfirmed: rows.length > 0 && rows.every(row => row.cardCount > 0 && row.stabilityWindowMs >= 500 && row.observedStableMs - row.lastCardChangeMs >= 500),
    last20HeapBytes: tail.length ? {min: Math.min(...tail), max: Math.max(...tail)} : null,
    observedSlowStopCacheWrites: rows.reduce((count, row) => count + row.slowTransactions.filter(tx => tx.stage === 'idb-write' && tx.stores.includes('stops')).length, 0),
  };
}
const fixtureMisses = capture.logs.filter(row => row.type === 'fixture-miss').length;
const valid = cityIds.length === 2 && new Set(cityIds).size === 2 && capture.gpu === true && capture.profileCpu === false && capture.fixtureMode === 'replay' && samples.length === 100 && fixtureMisses === 0 && Object.values(cities).every(city => city.samples === 50 && city.allActivityComplete && city.allStabilityWindowsConfirmed);
const summary = {
  workload: '100 alternating city arrivals, native clocks, identical replayed transit bytes',
  percentileMethod: 'nearest rank',
  graphics: capture.graphics,
  fixtureMode: capture.fixtureMode,
  fixtureMisses,
  switches: samples.length,
  cities,
  warmGate: {limitMs: 1000, valid, passed: valid && Object.values(cities).every(city => city.indexMs.p95 <= 1000 && city.authoritativeActivityMs.p95 <= 1000 && city.lastCardChangeMs.p95 <= 1000)},
  panFrames: distribution(capture.panFrameIntervalsMs ?? []),
  limits: 'Synthetic arrivals on the reference desktop; does not establish live staging or phone performance. Heap ranges are observations, not a universal leak proof. API write count includes only transactions at least 20 ms.',
};
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.warmGate.passed ? 0 : 1;
