// Isolated profile; measures metadata discovery with eight large legacy packages.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, webkit} = require(path.resolve(__dirname, '../../packages/frontend/node_modules/@playwright/test'));
const args = process.argv.slice(2);
const origin = args.find(value => !value.startsWith('--')) || 'http://127.0.0.1:5188';
const output = process.env.PTN_METADATA_OUTPUT || '/tmp/ptn-city-metadata';
(async () => {
  const name = args.includes('--webkit') ? 'webkit' : 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch({headless: true});
  try {
    const page = await browser.newPage({serviceWorkers: 'block'});
    await page.route('**/metadata-probe', route => route.fulfill({contentType: 'text/html', body: '<html><body>Metadata probe</body></html>'}));
    await page.goto(origin + '/metadata-probe');
    const result = await page.evaluate(async () => {
      const {db} = await import('/src/db/index.ts');
      const {listDeviceCities} = await import('/src/services/deviceCities.ts');
      await db.open();
      const measure = async expected => {
        const times = [];
        for (let i = 0; i < 100; i++) {
          const start = performance.now();
          const rows = await listDeviceCities();
          if (rows.length !== expected) throw new Error('Incorrect metadata count');
          times.push(performance.now() - start);
        }
        times.sort((a,b) => a-b);
        return {samples: times.length, p50Ms: times[49], p95Ms: times[94], maxMs: times[99]};
      };
      const empty = await measure(0);
      const payloadBytes = 21 * 1024 * 1024;
      const payload = new Uint8Array(payloadBytes);
      await db.offlineCities.bulkPut(Array.from({length: 8}, (_, i) => ({
        cityId: `probe-${i}`, city: {id: `probe-${i}`, name: `Probe ${i}`}, preparedAt: 1,
        sizeBytes: payloadBytes, tables: {opaqueLegacyPayload: [{bytes: payload}]},
      })));
      let payloadReads = 0;
      const originals = new Map();
      for (const method of ['get', 'getAll', 'openCursor']) {
        const original = IDBObjectStore.prototype[method];
        originals.set(method, original);
        IDBObjectStore.prototype[method] = function (...values) {
          if (this.name === 'offlineCities') payloadReads++;
          return original.apply(this, values);
        };
      }
      try {
        const legacy = await measure(8);
        await db.offlineCityMetadata.bulkPut(Array.from({length: 8}, (_, i) => ({
          cityId: `probe-${i}`, state: 'complete', preparedAt: 1, sizeBytes: payloadBytes,
        })));
        const indexed = await measure(8);
        return {payloadBytesPerCity: payloadBytes, payloadReads, empty, legacy, indexed};
      } finally {
        for (const [method, original] of originals) IDBObjectStore.prototype[method] = original;
        db.close();
      }
    });
    assert.equal(result.payloadReads, 0);
    assert.ok(result.legacy.p95Ms - result.empty.p95Ms <= 50);
    assert.ok(result.indexed.p95Ms - result.empty.p95Ms <= 50);
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify({browser: name, ...result}, null, 2));
    console.log(JSON.stringify({browser: name, ...result}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
