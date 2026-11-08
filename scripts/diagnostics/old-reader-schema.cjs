// Isolated profile: run the unchanged base's DB reader against the v7 schema.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, webkit} = require(path.resolve(__dirname, '../../packages/frontend/node_modules/@playwright/test'));
const args = process.argv.slice(2);
const origin = args.find(value => !value.startsWith('--')) || 'http://127.0.0.1:5189';
const name = args.includes('--webkit') ? 'webkit' : 'chromium';
const output = process.env.PTN_SCHEMA_OUTPUT || '/tmp/ptn-schema-compat';

(async () => {
  const browser = await (name === 'webkit' ? webkit : chromium).launch({headless: true});
  try {
    const page = await browser.newPage({serviceWorkers: 'block'});
    await page.route('**/schema-compat-probe', route => route.fulfill({contentType: 'text/html', body: '<html><body>Isolated schema probe</body></html>'}));
    await page.goto(origin + '/schema-compat-probe');
    const result = await page.evaluate(async () => {
      const {db, STORES} = await import('/src/db/index.ts');
      const declaredVersion = db.verno;
      await db.open();
      await db.savedLocations.put({id: 'probe-save', cityId: 'vilnius', alias: 'sentinel', savedAt: 1});
      let versionChanges = 0;
      db.backendDB().addEventListener('versionchange', () => versionChanges++);
      const Dexie = db.constructor;
      const newer = new Dexie('ptn');
      newer.version(7).stores({...STORES, offlineCityMetadata: 'cityId', cityUsageStats: 'id, cityId, lastTapped',
        savedLocations: 'id, savedAt, cityId', recentLocations: 'id, usedAt, cityId',
        cityArtifacts: 'key', cityArtifactMetadata: 'key, cityId', cityCachePointers: 'cityId',
        cityShapes: 'hash', sharedArtifactMetadata: 'key'});
      await newer.open();
      const oldConnectionClosed = !db.isOpen();
      await newer.table('cityArtifacts').put({key: 'probe-artifact', cityId: 'vilnius'});
      await newer.table('cityShapes').put({hash: 'probe-shape', bytes: new Uint8Array([1])});
      await newer.table('sharedArtifactMetadata').put({key: 'shapes:probe-shape', kind: 'shapes', hash: 'probe-shape', sizeBytes: 1, lastUsedAt: 1});
      newer.close();
      const {ensureDbReady} = await import('/src/db/migrationRunner.ts');
      const opened = await ensureDbReady();
      const saved = await db.savedLocations.get('probe-save');
      const native = db.backendDB();
      const nativeVersion = native.version;
      const read = async (table, key) => new Promise((resolve, reject) => {
        const request = native.transaction(table).objectStore(table).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const artifact = await read('cityArtifacts', 'probe-artifact');
      const shape = await read('cityShapes', 'probe-shape');
      const inventory = await read('sharedArtifactMetadata', 'shapes:probe-shape');
      db.close();
      return {declaredVersion, nativeVersion, versionChanges, oldConnectionClosed, recovered: opened.recovered,
        savedPreserved: saved?.alias === 'sentinel' && saved?.cityId === 'vilnius',
        artifactPreserved: artifact?.key === 'probe-artifact', shapePreserved: shape?.bytes[0] === 1,
        inventoryPreserved: inventory?.sizeBytes === 1};
    });
    assert.equal(result.declaredVersion, 2, 'Serve the unchanged requested base for this probe');
    assert.equal(result.nativeVersion, 70);
    assert.ok(result.versionChanges >= 1);
    assert.equal(result.oldConnectionClosed, true);
    assert.equal(result.recovered, false);
    for (const key of ['savedPreserved', 'artifactPreserved', 'shapePreserved', 'inventoryPreserved']) assert.equal(result[key], true);
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify({browser: name, ...result}, null, 2));
    console.log(JSON.stringify({browser: name, ...result}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
