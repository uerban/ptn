// Isolated browser; no deployment or persistent user-profile changes.
// node scripts/diagnostics/city-switch.cjs [origin] [--gpu] [--arrival-only]
// Local DEV / VITE_E2E builds expose the supported __ptnMap hook. Historical
// deployed builds can be examined explicitly with --legacy-react-probe.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {chromium} = require(path.resolve(__dirname, '../../packages/frontend/node_modules/@playwright/test'));
const args = process.argv.slice(2);
const origin = args.find(arg => !arg.startsWith('--')) || 'http://localhost:5173';
const cityCatalogFile = args.find(arg => arg.startsWith('--city-catalog='))?.slice('--city-catalog='.length);
const citySequenceArg = args.find(arg => arg.startsWith('--cities='))?.slice('--cities='.length);
const cityCatalog = cityCatalogFile ? JSON.parse(fs.readFileSync(cityCatalogFile, 'utf8')).cities : null;
const citySequence = (citySequenceArg || 'vilnius,krakow').split(',').map(id => {
  const city = cityCatalog?.find(city => city.id === id) || ({vilnius: {id, center: {lat: 54.6872, lon: 25.2797}}, krakow: {id, center: {lat: 50.0647, lon: 19.945}}})[id];
  if (!city) throw new Error(`Missing city catalog entry: ${id}`);
  return {id: city.id, center: [city.center.lon, city.center.lat]};
});
if (citySequence.length < 2 || citySequence[0].id !== 'vilnius') throw new Error('Probe needs Vilnius followed by at least one other city');
const output = process.env.PTN_PERF_OUTPUT || '/tmp/ptn-perf';
const apiOrigin = args.find(arg => arg.startsWith('--api-origin='))?.slice('--api-origin='.length);
const recordApi = args.find(arg => arg.startsWith('--record-api='))?.slice('--record-api='.length);
const replayApi = args.find(arg => arg.startsWith('--replay-api='))?.slice('--replay-api='.length);
const retainedArg = args.find(arg => arg.startsWith('--retained='))?.slice('--retained='.length);
const retainedCount = retainedArg === undefined ? null : Number(retainedArg);
if (retainedCount !== null && (!Number.isInteger(retainedCount) || retainedCount < 0 || retainedCount > 8)) throw new Error('Retained fixture count must be 0..8');
if (recordApi && replayApi) throw new Error('Choose either API recording or replay');
const fixtureDir = recordApi || replayApi;
let fixedTime;
if (recordApi) {
  fs.mkdirSync(recordApi, {recursive: true});
  fixedTime = new Date().toISOString();
  fs.writeFileSync(path.join(recordApi, 'metadata.json'), JSON.stringify({fixedTime}));
} else if (replayApi) fixedTime = JSON.parse(fs.readFileSync(path.join(replayApi, 'metadata.json'), 'utf8')).fixedTime;

(async () => {
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: !args.includes('--gpu'),
    args: args.includes('--gpu') ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  let page;
  const net = [];
  const logs = [];
  try {
    // Service-worker requests bypass page.route; fixed-feed comparisons must
    // intercept every API request. SW/offline rollout is a separate scenario.
    page = await browser.newPage({viewport: {width: 1000, height: 700}, serviceWorkers: 'block'});
    if (fixedTime) await page.addInitScript(timestamp => {
      // Playwright's clock also replaces Performance APIs, erasing the real
      // measures this probe needs. Freeze only Date; timers, RAF and the
      // browser performance timeline retain their native behavior.
      const NativeDate = Date;
      globalThis.Date = new Proxy(NativeDate, {
        construct(target, values, newTarget) {
          return Reflect.construct(target, values.length ? values : [timestamp], newTarget);
        },
        apply() { return new NativeDate(timestamp).toString(); },
        get(target, key, receiver) { return key === 'now' ? () => timestamp : Reflect.get(target, key, receiver); },
      });
    }, new Date(fixedTime).getTime());
    // Local Vite normally targets one city backend and strips the city prefix.
    // An explicit multi-city API origin preserves deployed request paths.
    if (apiOrigin || fixtureDir) await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(origin).origin || !['GET', 'HEAD'].includes(request.method())) return route.continue();
      const requestPath = url.pathname + url.search;
      if (url.pathname === '/api/cities' && cityCatalog) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({schemaVersion: 2, cities: cityCatalog})});
      if (url.pathname === '/api/cities' && args.includes('--builtin-catalog')) {
        const cities = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../examples/native/city-presets.json'), 'utf8'));
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({schemaVersion: 2, cities})});
      }

      const key = createHash('sha256').update(request.method() + ' ' + requestPath).digest('hex');
      const metadataFile = fixtureDir && path.join(fixtureDir, key + '.json');
      const bodyFile = fixtureDir && path.join(fixtureDir, key + '.bin');
      if (replayApi) {
        if (!fs.existsSync(metadataFile)) {
          logs.push({type: 'fixture-miss', text: requestPath});
          return route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"fixture missing"}'});
        }
        const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        return route.fulfill({status: metadata.status, headers: metadata.headers, body: fs.readFileSync(bodyFile)});
      }
      const headersForRecording = recordApi ? {...await request.allHeaders()} : undefined;
      if (headersForRecording) {
        delete headersForRecording['if-none-match'];
        delete headersForRecording['if-modified-since'];
      }
      const response = await route.fetch({url: apiOrigin ? new URL(requestPath, apiOrigin).href : request.url(),
        ...(headersForRecording ? {headers: headersForRecording} : {})});
      if (!recordApi) return route.fulfill({response});
      const body = await response.body();
      const headers = response.headers();
      // APIRequestContext has decompressed the response body.
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      fs.writeFileSync(bodyFile, body);
      fs.writeFileSync(metadataFile, JSON.stringify({method: request.method(), path: requestPath, status: response.status(), headers}));
      return route.fulfill({status: response.status(), headers, body});
    });
    page.on('console', message => { if (logs.length < 500) logs.push({type: message.type(), text: message.text()}); });
    page.on('pageerror', error => logs.push({type: 'pageerror', text: String(error)}));
    page.on('response', r => {
      if (r.url().includes('/api/')) net.push({url: r.url(), status: r.status(), timing: r.request().timing()});
    });
    await page.addInitScript(() => {
      window.probeStages = [];
      window.probeEvents = [];
      const push = (list, value) => { if (list.length < 20000) list.push(value); };
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          const start = performance.now();
          push(window.probeStages, {stage: 'worker-start', url: String(url), at: start});
          this.addEventListener('message', () => push(window.probeStages,
            {stage: 'worker-message', url: String(url), at: performance.now(), duration: performance.now() - start}));
        }
      };
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...params) {
        const start = performance.now();
        const tx = original.apply(this, params);
        if (params[1] === 'readwrite' || params[1] === 'readonly') {
          for (const outcome of ['complete', 'abort']) tx.addEventListener(outcome, () => push(window.probeStages,
            {stage: params[1] === 'readwrite' ? 'idb-write' : 'idb-read', outcome, stores: Array.from(tx.objectStoreNames), at: start, duration: performance.now() - start}));
        }
        return tx;
      };
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) push(window.probeEvents, {...e.toJSON(), detail: e.detail ?? null});
      }).observe({entryTypes: ['measure', 'longtask']});
    });
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    if (!args.includes('--skip-chooser')) {
      const chooser = page.getByRole('button', {name: 'Vilnius', exact: true});
      await chooser.waitFor({timeout: 30000});
      await chooser.click();
      // The chooser also owns a MapLibre map; wait for its teardown first.
      await chooser.waitFor({state: 'detached', timeout: 30000});
    }
    await page.waitForFunction(legacy => window.__ptnMap ||
      (legacy && document.querySelector('.maplibregl-map')),
      args.includes('--legacy-react-probe'), {timeout: 30000});
    const map = await page.evaluate(legacy => {
      if (window.__ptnMap) window.probeMap = window.__ptnMap;
      else if (legacy) {
        // Historical capture compatibility only; candidate verification uses
        // the supported map hook and fails if it is absent.
        for (const el of document.querySelectorAll('*')) {
          const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
          for (let f = key && el[key], i = 0; f && i < 50; i++, f = f.return) {
            for (let h = f.memoizedState, j = 0; h && j < 100; j++, h = h.next) {
              const c = h.memoizedState?.current;
              if (c && typeof c.flyTo === 'function' && typeof c.getCenter === 'function') window.probeMap = c;
            }
          }
        }
      }
      if (!window.probeMap) throw new Error('Map hook missing: use a DEV/VITE_E2E build (or --legacy-react-probe for historical deployed evidence)');
      let last = '';
      const sample = () => {
        const cards = [...document.querySelectorAll('[data-stop-id]')].map(el => ({id: el.dataset.stopId, text: el.textContent}));
        const key = JSON.stringify(cards);
        if (key !== last && window.probeEvents.length < 20000) {
          window.probeEvents.push({type: 'cards', at: performance.now(), cards});
          last = key;
        }
      };
      new MutationObserver(sample).observe(document.body, {childList: true, subtree: true, characterData: true});
      window.probeMap.jumpTo({zoom: 16});
      const gl = window.probeMap.getCanvas().getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      window.probeGraphics = gl ? {vendor: debug && gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
        renderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)} : null;
      return {center: window.probeMap.getCenter(), zoom: window.probeMap.getZoom(), graphics: window.probeGraphics};
    }, args.includes('--legacy-react-probe'));
    console.log('map', map);
    await page.waitForFunction(() =>
      performance.getEntriesByName('ptn:gtfs-init-end').length > 0 ||
      performance.getEntriesByName('ptn:city:index-build').some(e => e.detail?.cityId === 'vilnius' && e.detail.outcome === 'complete'),
      null, {timeout: 60000});
    if (retainedCount !== null) {
      const templateFile = fixtureDir && path.join(fixtureDir, 'retained-template.json');
      const serialized = templateFile && fs.existsSync(templateFile) ? fs.readFileSync(templateFile, 'utf8') : null;
      const capturedTemplate = await page.evaluate(async ({count, serialized}) => {
      const restored = serialized ? JSON.parse(serialized, (_key, value) => {
        if (value?.probeType === 'Uint8Array') return new Uint8Array(value.values);
        if (value?.probeType === 'ArrayBuffer') return new Uint8Array(value.values).buffer;
        return value;
      }) : null;
      const {db} = await import('/src/db/index.ts');
      const {useCityStore} = await import('/src/stores/cityStore.ts');
      const city = restored?.city ?? useCityStore.getState().activeCity;
      const modern = db.tables.some(table => table.name === 'cityArtifacts');
      const active = modern ? (await import('/src/services/cityData.ts')).useCityDataStore.getState().active : null;
      const names = ['gtfsRoutes', 'gtfsTrips', 'gtfsServices', 'gtfsStops', 'gtfsShapes', 'gtfsSyncMeta', 'stopGroups'];
      const template = restored?.tables ?? {};
      if (!restored) for (const name of names) template[name] = active ? active.values(name) : await db.table(name).toArray();
      const ptb = restored?.ptb ?? await db.ptbBytes.get(city.id) ??
        (active?.artifact ? {...active.artifact.ptb, cityId: city.id} : null);
      if (!ptb) throw new Error('Retained fixture requires initial PTB bytes');
      let bundle = restored?.bundle ?? await db.gtfsBundle.get(city.id);
      if (!bundle && active) {
        const {encodeGzipJson} = await import('/src/services/gtfsBundle.ts');
        const encoded = await encodeGzipJson(active.wire);
        bundle = {cityId: city.id, format: 'gzip', compressedBytes: encoded.compressed,
          compressedSize: encoded.compressed.byteLength, decompressedSize: encoded.decompressedSize};
      }
      if (!bundle) throw new Error('Retained fixture requires initial compressed catalog');
      for (let i = 0; i < count; i++) {
        const id = `probe-retained-${i}`;
        await db.offlineCities.put({cityId: id, city: {...city, id, name: `Archived fixture ${i}`},
          preparedAt: Date.now(), sizeBytes: ptb.bytes.byteLength + bundle.compressedSize,
          tables: {...template, gtfsSyncMeta: template.gtfsSyncMeta.map(row => ({...row, cityId: id})),
            ptbBytes: [{...ptb, cityId: id}], gtfsBundle: [{...bundle, cityId: id}]}});
        if (modern) await db.offlineCityMetadata.put({cityId: id, state: 'legacy'});
      }
      // These inert packages model existing legacy downloads; they are never
      // opened as real cities. Measure list discovery separately from seeding.
      const {listDeviceCities} = await import('/src/services/deviceCities.ts');
      const started = performance.now();
      const listed = await listDeviceCities();
      window.probeEvents.push({type: 'retained-fixture', count, listed: listed.length,
        discoveryMs: performance.now() - started,
        rowsPerPackage: Object.fromEntries(names.map(name => [name, template[name].length]))});
      return serialized ?? JSON.stringify({city, tables: template, ptb, bundle}, (_key, value) => {
        if (value instanceof Uint8Array) return {probeType: 'Uint8Array', values: Array.from(value)};
        if (value instanceof ArrayBuffer) return {probeType: 'ArrayBuffer', values: Array.from(new Uint8Array(value))};
        return value;
      });
      }, {count: retainedCount, serialized});
      if (templateFile && !serialized) fs.writeFileSync(templateFile, capturedTemplate);
    }
    const cdp = await page.context().newCDPSession(page);
    const profileCpu = !args.includes('--no-cpu-profile');
    if (profileCpu) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    await page.evaluate(() => {
      window.probeFrames = [];
      window.probePanFrames = [];
      window.probePanSamples = [];
      window.probeFramesActive = true;
      let previous;
      const frame = now => {
        if (!window.probeFramesActive) return;
        if (previous !== undefined) {
          window.probeFrames.push(now - previous);
          if (window.probeFramePhase === 'pan') {
            window.probePanFrames.push(now - previous);
            window.probePanSamples.push({zoom: window.probePanZoom, urbanMode: window.probePanUrban, intervalMs: now - previous});
          }
        }
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.evaluate(({arrivalOnly, center}) => new Promise(resolve => {
      const map = window.probeMap;
      window.probeEvents.push({type: 'switch', at: performance.now(), arrivalOnly});
      if (arrivalOnly) {
        map.jumpTo({center, zoom: 16});
        map.fire('moveend', {originalEvent: {type: 'mouseup'}});
        resolve();
      } else {
        map.once('moveend', () => {
          window.probeEvents.push({type: 'arrival', at: performance.now()});
          // Same terminal user move used by pan-to-city detection, after the
          // real animated flight rather than a synthetic arrival-only jump.
          map.fire('moveend', {originalEvent: {type: 'mouseup'}});
          resolve();
        });
        map.flyTo({center, zoom: 16, duration: 1200, essential: true});
      }
    }), {arrivalOnly: args.includes('--arrival-only'), center: citySequence[1].center});
    const captureMs = Number(args.find(arg => arg.startsWith('--capture-ms='))?.slice('--capture-ms='.length) || 25000);
    if (!Number.isFinite(captureMs) || captureMs < 1000 || captureMs > 60000) throw new Error('Capture duration must be 1000..60000 ms');
    await page.waitForTimeout(captureMs);
    const repeatCount = Number(args.find(arg => arg.startsWith('--repeat='))?.slice('--repeat='.length) || 0);
    if (!Number.isInteger(repeatCount) || repeatCount < 0 || repeatCount > 100) throw new Error('Repeat count must be 0..100');
    const repeated = [];
    for (let iteration = 0; iteration < repeatCount; iteration++) {
      if (args.includes('--bounded-diagnostics')) await page.evaluate(() => {
        window.probeEvents = []; window.probeStages = []; window.probeFrames = [];
        performance.clearResourceTimings();
      });
      if (args.includes('--bounded-diagnostics')) await cdp.send('Runtime.discardConsoleEntries');
      await cdp.send('HeapProfiler.collectGarbage');
      const sample = await page.evaluate(async ({iteration, cityId, center, allowEmpty}) => {
        const start = performance.now();
        const map = window.probeMap;
        map.jumpTo({center, zoom: 16});
        map.fire('moveend', {originalEvent: {type: 'mouseup'}});
        const pause = () => new Promise(resolve => setTimeout(resolve, 25));
        while (!performance.getEntriesByName('ptn:city:index-build').some(entry =>
          entry.startTime >= start && entry.detail?.cityId === cityId && entry.detail?.outcome === 'complete')) {
          if (performance.now() - start > 20000) throw new Error(`Repeated activation timeout: ${cityId}`);
          await pause();
        }
        const readyMs = performance.now() - start;
        let activity;
        while (!(activity = performance.getEntriesByName('ptn:city:badge-activity').find(entry =>
          entry.startTime >= start && entry.detail?.cityId === cityId))) {
          if (performance.now() - start > 20000) throw new Error(`Repeated activity publication timeout: ${cityId}`);
          await pause();
        }
        const activityReadyMs = activity.startTime + activity.duration - start;
        let fingerprint = '', stableSince = performance.now();
        while (true) {
          const next = JSON.stringify([...document.querySelectorAll('[data-stop-id]')].map(el => [el.dataset.stopId, el.textContent]));
          if (next !== fingerprint) {fingerprint = next; stableSince = performance.now();}
          if (performance.now() - stableSince >= 500 && (document.querySelector('[data-stop-id]') || (allowEmpty && activity.detail.outcome === 'complete' && activity.detail.requested > 0))) break;
          if (performance.now() - start > 20000) throw new Error(`Repeated badge settlement timeout: ${cityId}`);
          await pause();
        }
        return {iteration, cityId, readyMs, activityReadyMs, activity: activity.detail,
          lastCardChangeMs: stableSince - start, observedStableMs: performance.now() - start,
          slowTransactions: window.probeStages.filter(entry => entry.at >= start && entry.duration >= 20 && entry.stage.startsWith('idb-'))
            .map(entry => ({...entry, at: entry.at - start})),
          longTasks: window.probeEvents.filter(entry => entry.entryType === 'longtask' && entry.startTime >= start)
            .map(entry => ({startMs: entry.startTime - start, durationMs: entry.duration})),
          stages: performance.getEntriesByType('measure').filter(entry => entry.name.startsWith('ptn:city:') && entry.startTime >= start)
            .map(entry => ({name: entry.name, startMs: entry.startTime - start, durationMs: entry.duration, detail: entry.detail})),
          stabilityWindowMs: 500, cardCount: document.querySelectorAll('[data-stop-id]').length,
          settlement: allowEmpty ? 'DOM content unchanged for 500 ms; authoritative empty allowed' : 'nonempty DOM card content unchanged for 500 ms'};
      }, {iteration, cityId: citySequence[iteration % citySequence.length].id, center: citySequence[iteration % citySequence.length].center, allowEmpty: args.includes('--allow-empty')});
      await cdp.send('HeapProfiler.collectGarbage');
      sample.heap = await cdp.send('Runtime.getHeapUsage');
      repeated.push(sample);
      fs.writeFileSync(path.join(output, 'repeated.json'), JSON.stringify(repeated, null, 2));
    }
    if (args.includes('--pan')) {
      const zooms = (args.find(arg => arg.startsWith('--pan-zooms='))?.slice('--pan-zooms='.length) || '16').split(',').map(Number);
      const modes = (args.find(arg => arg.startsWith('--pan-modes='))?.slice('--pan-modes='.length) || 'all').split(',');
      if (!zooms.length || zooms.some(zoom => !Number.isFinite(zoom) || zoom < 0 || zoom > 22)) throw new Error('Invalid pan zooms');
      if (!modes.length || modes.some(mode => !['all', 'urban'].includes(mode))) throw new Error('Invalid pan modes');
      for (const mode of modes) {
        const all = mode === 'all';
        if ((await page.getByTestId('mode-toggle').getAttribute('aria-label') === 'All') !== all) await page.getByTestId('mode-toggle').click();
        await page.waitForFunction(all => (document.querySelector('[data-testid="mode-toggle"]')?.getAttribute('aria-label') === 'All') === all, all);
        await page.evaluate(async ({zooms, urbanMode}) => {
          const map = window.__ptnMap || window.probeMap;
          for (const zoom of zooms) {
            map.jumpTo({zoom});
            await new Promise(resolve => setTimeout(resolve, 1000));
            window.probeEvents.push({type: 'pan-start', at: performance.now(), urbanMode, zoom});
            window.probePanZoom = zoom;
            window.probePanUrban = urbanMode;
            window.probeFramePhase = 'pan';
            for (const offset of [[150, 0], [0, 100], [-150, 0], [0, -100]]) {
              await new Promise(resolve => {
                map.once('moveend', resolve);
                map.panBy(offset, {duration: 1000, essential: true});
              });
            }
            window.probeFramePhase = null;
            window.probeEvents.push({type: 'pan-end', at: performance.now(), urbanMode, zoom});
          }
        }, {zooms, urbanMode: !all});
      }
    }
    if (args.includes('--heap-snapshot')) {
      await cdp.send('Runtime.discardConsoleEntries');
      await cdp.send('HeapProfiler.collectGarbage');
      const snapshotFile = fs.openSync(path.join(output, 'final.heapsnapshot'), 'w');
      const writeChunk = ({chunk}) => fs.writeSync(snapshotFile, chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', writeChunk);
      try { await cdp.send('HeapProfiler.takeHeapSnapshot', {reportProgress: false}); }
      finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', writeChunk); fs.closeSync(snapshotFile); }
    }
    const profile = profileCpu ? await cdp.send('Profiler.stop') : null;
    const capture = await page.evaluate(() => { window.probeFramesActive = false; return {capturedAt: performance.now(), events: window.probeEvents, stages: window.probeStages, graphics: window.probeGraphics, frameIntervalsMs: window.probeFrames, panFrameIntervalsMs: window.probePanFrames, panSamples: window.probePanSamples,
      performance: performance.getEntries().filter(e => ['measure', 'mark', 'resource'].includes(e.entryType)).map(e => ({...e.toJSON(), detail: e.detail ?? null}))}; });
    fs.writeFileSync(path.join(output, 'live.json'), JSON.stringify({origin, apiOrigin, fixedTime,
      citySequence: citySequence.map(city => city.id), fixtureMode: replayApi ? 'replay' : recordApi ? 'record' : 'live', retainedCount, gpu: args.includes('--gpu'), profileCpu, boundedDiagnostics: args.includes('--bounded-diagnostics'), net, logs, ...capture}, null, 2));
    if (profile) fs.writeFileSync(path.join(output, 'switch.cpuprofile'), JSON.stringify(profile.profile));
    if (replayApi && logs.some(log => log.type === 'fixture-miss')) throw new Error('Incomplete replay: API fixture misses recorded');
    console.log(`Saved ${net.length} network events to ${output}`);
  } catch (error) {
    const evidence = page ? await page.evaluate(() => ({events: window.probeEvents, stages: window.probeStages,
      performance: performance.getEntries().filter(e => ['measure', 'mark', 'resource'].includes(e.entryType)).map(e => e.toJSON())})).catch(() => null) : null;
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({origin, error: String(error), net, logs, evidence}, null, 2));
    throw error;
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
