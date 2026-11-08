// Fresh browser per sample; identical captured transit API bodies and native GPU.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const origin = process.argv[2] || 'http://127.0.0.1:4190';
const fixture = process.argv[3] || '/tmp/ptn-fixed-api-v2';
const output = process.env.PTN_COLD_OUTPUT || '/tmp/ptn-cold-replays';
fs.mkdirSync(output, {recursive: true});
const samples = [];
let renderer;
for (let i = 0; i < 10; i++) {
  const destination = path.join(output, String(i));
  const child = spawnSync(process.execPath, [path.join(__dirname, 'city-switch.cjs'), origin,
    '--gpu', '--arrival-only', '--replay-api=' + fixture, '--builtin-catalog',
    '--no-cpu-profile', '--capture-ms=3000'], {
    env: {...process.env, PTN_PERF_OUTPUT: destination}, encoding: 'utf8',
  });
  fs.writeFileSync(path.join(output, i + '.log'), child.stdout + child.stderr);
  assert.equal(child.status, 0, 'Cold browser replay failed: ' + i);
  const capture = JSON.parse(fs.readFileSync(path.join(destination, 'live.json'), 'utf8'));
  assert.equal(capture.logs.filter(event => event.type === 'fixture-miss').length, 0);
  assert.ok(!/swiftshader/i.test(capture.graphics.renderer));
  renderer ??= capture.graphics;
  assert.deepEqual(capture.graphics, renderer);
  const stage = name => capture.performance.find(entry => entry.name === 'ptn:city:' + name && entry.detail?.cityId === 'krakow');
  const fetched = stage('catalog-fetch'), index = stage('index-build'), activity = stage('badge-activity');
  assert.ok(fetched && index && activity, 'Incomplete cold activation capture');
  assert.equal(activity.detail.outcome, 'complete');
  const verified = fetched.startTime + fetched.duration;
  const cardChanges = capture.events.filter(event => event.type === 'cards' && event.at >= verified);
  assert.ok(cardChanges.length > 0);
  const lastCardChange = cardChanges[cardChanges.length - 1];
  assert.ok(capture.capturedAt - lastCardChange.at >= 500, 'Card stability observation too short');
  const sample = {indexLocalMs: index.startTime + index.duration - verified,
    activityLocalMs: activity.startTime + activity.duration - verified,
    lastCardChangeLocalMs: lastCardChange.at - verified,
    requestedStops: activity.detail.requested, readyStops: activity.detail.ready};
  assert.ok(sample.indexLocalMs >= 0 && sample.activityLocalMs >= 0);
  samples.push(sample);
  fs.writeFileSync(path.join(output, 'samples.json'), JSON.stringify(samples, null, 2));
  console.log('Cold replay ' + (i + 1) + '/10: local activity ' + sample.activityLocalMs.toFixed(1) + ' ms');
}
const percentile = (key, q) => samples.map(sample => sample[key]).sort((a,b) => a-b)[Math.ceil(samples.length * q)-1];
const result = {scenario: 'Ten fresh native-GPU browser contexts; cold Krakow after initial Vilnius, fixed API replay',
  renderer, samples, p95: {indexLocalMs: percentile('indexLocalMs', .95),
    activityLocalMs: percentile('activityLocalMs', .95), lastCardChangeLocalMs: percentile('lastCardChangeLocalMs', .95)},
  caveats: ['Local timing starts after verified catalog acquisition, excluding network transfer and ready bracketing.',
    'External basemap resources remain live; no mobile or staging claim.']};
assert.ok(result.p95.indexLocalMs <= 2000);
assert.ok(result.p95.activityLocalMs <= 2000);
assert.ok(result.p95.lastCardChangeLocalMs <= 2000);
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2));
