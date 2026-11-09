// Actual v2→v7 migrations, interrupted during metadata backfill, then retried.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, webkit} = require(path.resolve(__dirname, '../../packages/frontend/node_modules/@playwright/test'));
const args = process.argv.slice(2);
const origin = args.find(value => !value.startsWith('--')) || 'http://127.0.0.1:5188';
const output = process.env.PTN_SCHEMA_RETRY_OUTPUT || '/tmp/ptn-schema-retry';
(async () => {
  const name = args.includes('--webkit') ? 'webkit' : 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch({headless: true});
  try {
    const page = await browser.newPage({serviceWorkers: 'block'});
    await page.route('**/schema-retry-probe', route => route.fulfill({contentType: 'text/html', body: '<html><body>Schema retry probe</body></html>'}));
    await page.goto(origin + '/schema-retry-probe');
    const result = await page.evaluate(async () => {
      const {db, STORES} = await import('/src/db/index.ts');
      const Dexie = db.constructor;
      const added = new Set(['offlineCityMetadata','cityUsageStats','cityArtifacts','cityArtifactMetadata','cityCachePointers','cityShapes','sharedArtifactMetadata']);
      const oldStores = {...Object.fromEntries(Object.entries(STORES).filter(([name]) => !added.has(name))),
        savedLocations: 'id, savedAt', recentLocations: 'id, usedAt'};
      const old = new Dexie('ptn');
      old.version(2).stores(oldStores);
      await old.open();
      await old.table('savedLocations').put({id: 'saved', alias: 'Home', encrypted: false,
        endpoint: {kind: 'mappoint', lat: 1, lon: 2}, savedAt: 1});
      await old.table('offlineCities').put({cityId: 'vilnius', preparedAt: 1, sizeBytes: 3,
        tables: {originalPayload: [{bytes: new Uint8Array([1,2,3])}]}});
      await old.table('offlineTransfers').put({hash: 'transfer', bytes: new Uint8Array([4,5,6])});
      let changes = 0;
      old.backendDB().addEventListener('versionchange', () => changes++);
      let injected = false, payloadReads = 0;
      const put = IDBObjectStore.prototype.put;
      const methods = new Map();
      for (const name of ['get','getAll','openCursor']) {
        const original = IDBObjectStore.prototype[name]; methods.set(name, original);
        IDBObjectStore.prototype[name] = function (...args) {
          if (this.transaction.mode === 'versionchange' && ['offlineCities','offlineTransfers'].includes(this.name)) payloadReads++;
          return original.apply(this, args);
        };
      }
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (!injected && this.name === 'offlineCityMetadata' && this.transaction.mode === 'versionchange') {
          injected = true;
          request.addEventListener('success', () => this.transaction.abort(), {once: true});
        }
        return request;
      };
      let rejected = false;
      try { await db.open(); } catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = put; }
      const rolledBack = await new Promise((resolve,reject) => {
        const request = indexedDB.open('ptn');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const native = request.result;
          const result = {version: native.version, addedTableAbsent: !native.objectStoreNames.contains('offlineCityMetadata')};
          native.close(); resolve(result);
        };
      });
      const {ensureDbReady} = await import('/src/db/migrationRunner.ts');
      const retry = await ensureDbReady();
      for (const [name, original] of methods) IDBObjectStore.prototype[name] = original;
      const saved = await db.savedLocations.get('saved');
      const pkg = await db.offlineCities.get('vilnius');
      const transfer = await db.offlineTransfers.get('transfer');
      const metadata = await db.offlineCityMetadata.get('vilnius');
      const inventory = await db.sharedArtifactMetadata.get('transfers:transfer');
      const result = {injected, rejected, versionChanges: changes, oldClosed: !old.isOpen(), rolledBack,
        retryRecovered: retry.recovered, finalVersion: db.backendDB().version, payloadReads,
        savedPreserved: saved?.alias === 'Home' && saved?.cityId === undefined,
        packagePreserved: [...pkg.tables.originalPayload[0].bytes].join() === '1,2,3',
        transferPreserved: [...transfer.bytes].join() === '4,5,6',
        legacyMetadata: metadata?.state === 'legacy', inventoryPreserved: inventory?.hash === 'transfer',
        ownershipIndex: db.savedLocations.schema.indexes.some(index => index.name === 'cityId')};
      db.close(); return result;
    });
    assert.equal(result.injected, true); assert.equal(result.rejected, true);
    assert.equal(result.rolledBack.version, 20); assert.equal(result.rolledBack.addedTableAbsent, true);
    assert.equal(result.finalVersion, 70); assert.equal(result.retryRecovered, false);
    assert.equal(result.payloadReads, 0); assert.ok(result.versionChanges >= 1);
    for (const key of ['oldClosed','savedPreserved','packagePreserved','transferPreserved','legacyMetadata','inventoryPreserved','ownershipIndex']) assert.equal(result[key], true);
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify({browser:name,...result},null,2));
    console.log(JSON.stringify({browser:name,...result}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
