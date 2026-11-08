import type { Table } from "dexie";
import { create } from "zustand";
import type { RoutingBundleData } from "@pt/shared";
import { db, type GtfsRouteRecord, type GtfsTripRecord, type GtfsStopRecord,
  type GtfsServiceRecord, type GtfsShapeRecord, type GtfsSyncMeta, type StopGroupRecord } from "../db/index.ts";
import type {CityArtifactRecord} from "../db/index.ts";
import {holdSharedArtifactReferences} from "./sharedCityArtifacts.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { canonicalCityId } from "../utils/cityId.ts";
import { aggregateDisplayRoutes } from "./catalogProjection.ts";
import { groupStops } from "./stopGrouping.ts";

type CityRows = {
  gtfsRoutes: GtfsRouteRecord;
  gtfsTrips: GtfsTripRecord;
  gtfsStops: GtfsStopRecord;
  gtfsServices: GtfsServiceRecord;
  gtfsShapes: GtfsShapeRecord;
  gtfsSyncMeta: GtfsSyncMeta;
  stopGroups: StopGroupRecord;
};
type CityTable = keyof CityRows;
const primaryKeys: {[K in CityTable]: keyof CityRows[K]} = {gtfsRoutes: "id", gtfsTrips: "tripId", gtfsStops: "id", gtfsServices: "serviceId",
  gtfsShapes: "shapeId", gtfsSyncMeta: "id", stopGroups: "groupId"};

export interface CityDataToken { readonly cityId: string; readonly generationId: string; readonly activationEpoch: number }
let nextEpoch = 0;

/** One decoded city. Derived indexes are lazy; inactive cities retain binary artifacts only. */
export class CityDataContext {
  readonly token: CityDataToken;
  private readonly rows: Partial<{[K in CityTable]: CityRows[K][]}> = {};
  private readonly indexes = new Map<CityTable, {rows: unknown; values: Map<string, unknown>}>();

  constructor(readonly wire: RoutingBundleData, readonly meta: GtfsSyncMeta, shapes: GtfsShapeRecord[] = [],
    readonly artifact?: CityArtifactRecord) {
    const cityId = canonicalCityId(meta.cityId);
    const generationId = meta.generationId || meta.etag;
    if (!generationId || (wire.meta.cityId && canonicalCityId(wire.meta.cityId) !== cityId)) {
      throw new Error("Catalog city/generation provenance does not match its metadata");
    }
    if (artifact && (artifact.cityId !== cityId || artifact.generation.generationId !== generationId || artifact.ptb.etag !== meta.etag)) {
      throw new Error("Raw timetable and decoded catalog provenance do not match");
    }
    this.meta = {...meta, cityId, generationId};
    this.token = {cityId, generationId, activationEpoch: ++nextEpoch};
    this.rows.gtfsStops = wire.stops;
    this.rows.gtfsServices = wire.calendar;
    this.rows.gtfsShapes = shapes;
    this.rows.gtfsSyncMeta = [this.meta];
  }

  values<K extends CityTable>(name: K): CityRows[K][] {
    if (!this.rows[name]) {
      if (name === "gtfsRoutes") this.rows.gtfsRoutes = aggregateDisplayRoutes(this.wire.routes);
      if (name === "gtfsTrips") this.rows.gtfsTrips = this.wire.routes.flatMap(route => route.trips.map(trip => ({...trip, routeId: route.id})));
      if (name === "stopGroups") this.rows.stopGroups = groupStops(this.wire.stops);
    }
    return this.rows[name]!;
  }

  get<K extends CityTable>(name: K, key: string): CityRows[K] | undefined {
    const rows = this.values(name);
    let index = this.indexes.get(name);
    if (!index || index.rows !== rows) {
      index = {rows, values: new Map(rows.map(row => [String(row[primaryKeys[name]]), row]))};
      this.indexes.set(name, index);
    }
    return index.values.get(key) as CityRows[K] | undefined;
  }

  replaceShapes(shapes: GtfsShapeRecord[]): void { this.rows.gtfsShapes = shapes; }
}

export const useCityDataStore = create<{active: CityDataContext | null; revision: number}>(() => ({active: null, revision: 0}));

let stopCitySubscription: (() => void) | undefined;
let releaseActiveArtifacts: (() => void) | undefined;

// Keep the lifetime subscription outside activation's closure: otherwise its
// shared lexical environment can retain the first decoded catalog forever.
function onSelectedCityChanged(state: ReturnType<typeof useCityStore.getState>, previous: ReturnType<typeof useCityStore.getState>): void {
  if (canonicalCityId(state.activeCity.id) !== canonicalCityId(previous.activeCity.id)) invalidateCityData();
}

export function activateCityData(context: CityDataContext): void {
  if (canonicalCityId(useCityStore.getState().activeCity.id) !== context.token.cityId) throw new StaleCityDataError();
  stopCitySubscription ??= useCityStore.subscribe(onSelectedCityChanged);
  const release = holdSharedArtifactReferences({artifactKey: context.artifact?.key,
    transfersHash: context.artifact?.ptb.transfersArtifact?.hash,
    shapesHash: context.artifact?.generation.shapesArtifact?.hash});
  releaseActiveArtifacts?.();
  releaseActiveArtifacts = release;
  useCityDataStore.setState(state => ({active: context, revision: state.revision + 1}));
}

export function invalidateCityData(): void {
  releaseActiveArtifacts?.();
  releaseActiveArtifacts = undefined;
  useCityDataStore.setState(state => ({active: null, revision: state.revision + 1}));
}

export function updateCityShapes(context: CityDataContext, shapes: GtfsShapeRecord[]): boolean {
  if (useCityDataStore.getState().active !== context) return false;
  context.replaceShapes(shapes);
  useCityDataStore.setState(state => ({revision: state.revision + 1}));
  return true;
}

export class StaleCityDataError extends Error {
  constructor() { super("City data changed during the read"); this.name = "AbortError"; }
}

interface ReadTable<Row> {
  get(key: string): Promise<Row | undefined>;
  bulkGet(keys: readonly string[]): Promise<(Row | undefined)[]>;
  toArray(): Promise<Row[]>;
  filter(predicate: (row: Row) => boolean): {toArray(): Promise<Row[]>};
}
export type CityDataRead = {[K in CityTable]: ReadTable<CityRows[K]>} & {
  readonly token: CityDataToken | null;
  assertCurrent(): void;
  runSnapshot<T>(read: () => Promise<T>): Promise<T>;
};

/** Capture once per asynchronous operation. Even a same-city generation change
 * invalidates an old view; callers must restart instead of mixing generations.
 * Legacy table reads are atomic with their city/generation metadata. */
export function captureCityData(cityId = useCityStore.getState().activeCity.id): CityDataRead {
  cityId = canonicalCityId(cityId);
  const captured = useCityDataStore.getState();
  const context = captured.active?.token.cityId === cityId ? captured.active : null;
  let legacyGeneration: string | undefined;
  const assertCurrent = () => {
    const current = useCityDataStore.getState();
    if (canonicalCityId(useCityStore.getState().activeCity.id) !== cityId ||
        (context ? current.active !== context : current.revision !== captured.revision)) throw new StaleCityDataError();
  };
  async function read<K extends CityTable, T>(name: K, live: (data: CityDataContext) => T,
    legacy: (table: Table<CityRows[K], string>) => PromiseLike<T>, missing: T): Promise<T> {
    assertCurrent();
    let result: T;
    if (context) result = live(context);
    else result = await db.transaction("r", [db.gtfsSyncMeta, db[name]], () => db.gtfsSyncMeta.get("current").then(meta => {
      if (!meta || canonicalCityId(meta.cityId) !== cityId) return missing;
      const generation = meta.generationId || meta.etag || String(meta.lastSynced);
      if (legacyGeneration !== undefined && legacyGeneration !== generation) throw new StaleCityDataError();
      legacyGeneration = generation;
      return legacy(db[name] as Table<CityRows[K], string>);
    }));
    assertCurrent();
    return result;
  }
  function table<K extends CityTable>(name: K): ReadTable<CityRows[K]> {
    return {
      get: key => read(name, data => data.get(name, key), table => table.get(key), undefined),
      bulkGet: keys => read(name, data => keys.map(key => data.get(name, key)), table => table.bulkGet([...keys]), keys.map(() => undefined)),
      toArray: () => read(name, data => [...data.values(name)], table => table.toArray(), []),
      filter: predicate => ({toArray: async () => (await table(name).toArray()).filter(predicate)}),
    };
  }
  const runSnapshot = async <T>(work: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const result = context ? await work() : await db.transaction("r", Object.keys(primaryKeys).map(name => db[name as CityTable]), work);
    assertCurrent();
    return result;
  };
  return {token: context?.token ?? null, assertCurrent, runSnapshot,
    gtfsRoutes: table("gtfsRoutes"), gtfsTrips: table("gtfsTrips"), gtfsStops: table("gtfsStops"),
    gtfsServices: table("gtfsServices"), gtfsShapes: table("gtfsShapes"), gtfsSyncMeta: table("gtfsSyncMeta"), stopGroups: table("stopGroups")};
}

if (import.meta.hot) import.meta.hot.dispose(() => {stopCitySubscription?.(); releaseActiveArtifacts?.();});
