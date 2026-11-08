// Real prior→candidate Workbox update with an unchanged v2 reader held open.
// All data and service workers live in a disposable localhost browser profile.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require(path.resolve(__dirname, '../../packages/frontend/node_modules/@playwright/test'));
const prior = process.argv[2] || '/tmp/ptn-schema-prior-pwa';
const candidate = process.argv[3] || path.resolve(__dirname, '../../packages/frontend/dist');
const oldSource = process.argv[4] || 'http://127.0.0.1:5189';
const output = process.env.PTN_PWA_UPGRADE_OUTPUT || '/tmp/ptn-pwa-upgrade.json';
let current = prior;
const catalog = {schemaVersion: 2, cities: [{id:'vilnius',name:'Vilnius',tz:'Europe/Vilnius',
  center:{lat:54.6872,lon:25.2797},bbox:{minLat:54.6,minLon:25.1,maxLat:54.8,maxLon:25.5}}]};
const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json',
  '.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.pbf':'application/octet-stream'};
const server = http.createServer((request,response) => {
  const url = new URL(request.url,'http://localhost');
  response.setHeader('Cache-Control','no-store');
  if (url.pathname === '/api/cities') {response.setHeader('Content-Type','application/json');return response.end(JSON.stringify(catalog));}
  if (url.pathname.startsWith('/api/')) {response.writeHead(503);return response.end('{}');}
  if (url.pathname === '/probe') {response.setHeader('Content-Type','text/html');return response.end('<html><body>Prior reader</body></html>');}
  let name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (name.split('/').includes('..')) {response.writeHead(400);return response.end();}
  let file = path.join(current,name);
  if (!fs.existsSync(file) && name.startsWith('assets/')) file = path.join(prior,name);
  if (!fs.existsSync(file)) file = path.join(current,'index.html');
  response.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
  response.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({serviceWorkers:'allow'});
    const oldPage = await context.newPage();
    await oldPage.goto(origin+'/probe');
    const old = await oldPage.evaluate(async oldSource => {
      localStorage.setItem('ptn-city',JSON.stringify({state:{activeCity:{id:'vilnius'}},version:0}));
      const {db} = await import(oldSource+'/src/db/index.ts');
      const {ensureDbReady} = await import(oldSource+'/src/db/migrationRunner.ts');
      await ensureDbReady();
      await db.savedLocations.put({id:'saved',alias:'Sentinel',savedAt:1,encrypted:false,
        endpoint:{kind:'mappoint',lat:1,lon:2}});
      await db.offlineCities.put({cityId:'vilnius',preparedAt:1,sizeBytes:3,
        tables:{originalPayload:[{bytes:new Uint8Array([1,2,3])}]}});
      const reader = window.__priorReader = {db,ensureDbReady,changes:0};
      db.backendDB().addEventListener('versionchange',()=>reader.changes++);
      const registration = await navigator.serviceWorker.register('/sw.js');
      const deadline = performance.now()+20000;
      while(registration.active?.state!=='activated') {
        if(performance.now()>deadline) throw new Error('Prior SW activation timeout');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      window.__priorWorker=registration.active;
      return {declaredVersion:db.verno,nativeVersion:db.backendDB().version};
    },oldSource);
    assert.equal(old.declaredVersion,2); assert.equal(old.nativeVersion,20);
    current=candidate;
    await oldPage.evaluate(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      const previous=window.__priorWorker;
      await registration.update();
      const deadline=performance.now()+20000;
      while(!(registration.active!==previous&&registration.active?.state==='activated')) {
        registration.waiting?.postMessage({type:'SKIP_WAITING'});
        if(performance.now()>deadline) throw new Error('Candidate SW update timeout');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    });
    const newPage=await context.newPage();
    await newPage.goto(origin+'/settings');
    await newPage.getByRole('link',{name:'Settings',exact:true}).waitFor({timeout:20000}).catch(async error=>{
      fs.writeFileSync(output+'.failure.json',JSON.stringify({body:await newPage.locator('body').innerText()},null,2));
      throw error;
    });
    let migrated = false;
    for (let attempt=0; attempt<100; attempt++) {
      migrated = await newPage.evaluate(async()=>{
        const request=indexedDB.open('ptn');
        return await new Promise(resolve=>{
          request.onsuccess=()=>{const db=request.result;const version=db.version;db.close();resolve(version===70);};
          request.onerror=()=>resolve(false);
        });
      });
      if (migrated) break;
      await newPage.waitForTimeout(50);
    }
    assert.equal(migrated,true);
    await newPage.evaluate(async()=>{
      const request=indexedDB.open('ptn');
      await new Promise((resolve,reject)=>{
        request.onsuccess=()=>{const db=request.result;const tx=db.transaction('cityArtifacts','readwrite');
          tx.objectStore('cityArtifacts').put({key:'new-sentinel',cityId:'vilnius'});
          tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
        request.onerror=()=>reject(request.error);
      });
    });
    const result=await oldPage.evaluate(async()=>{
      const reader=window.__priorReader;
      const closed=!reader.db.isOpen();
      const reopened=await reader.ensureDbReady();
      const saved=await reader.db.savedLocations.get('saved');
      const pkg=await reader.db.offlineCities.get('vilnius');
      const native=reader.db.backendDB();
      const get=(store,key)=>new Promise((resolve,reject)=>{
        const request=native.transaction(store).objectStore(store).get(key);
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      const meta=await get('offlineCityMetadata','vilnius');
      const newer=await get('cityArtifacts','new-sentinel');
      return {priorConnectionClosed:closed,versionChanges:reader.changes,recovered:reopened.recovered,
        nativeVersion:native.version,savedPreserved:saved?.alias==='Sentinel',
        packagePreserved:[...pkg.tables.originalPayload[0].bytes].join()==='1,2,3',
        legacyMetadata:meta?.state==='legacy',newRecordPreserved:newer?.key==='new-sentinel'};
    });
    assert.equal(result.nativeVersion,70);assert.equal(result.recovered,false);assert.ok(result.versionChanges>=1);
    for(const key of ['priorConnectionClosed','savedPreserved','packagePreserved','legacyMetadata','newRecordPreserved']) assert.equal(result[key],true);
    fs.writeFileSync(output,JSON.stringify({scenario:'Prior Workbox worker updated to candidate with a v2 reader open; real app upgrades schema and prior reader reopens',...result},null,2));
    console.log(JSON.stringify(result));
    await context.close();
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
