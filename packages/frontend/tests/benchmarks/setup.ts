// Bootstrap a fake IndexedDB implementation in Node so Dexie code paths that
// read from `db.gtfs*` work inside benchmarks without a browser.
import "fake-indexeddb/auto";
