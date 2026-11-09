import type {LabelAnchor, StopWithLines} from "@pt/shared";

type PointFeature = GeoJSON.Feature<GeoJSON.Point>;
type SourceData = GeoJSON.FeatureCollection<GeoJSON.Point>;
interface Source {setData(data: SourceData): unknown}
const installedData = new WeakMap<Source, SourceData>();

/** Remember addSource's initial data too: the first badge update is a no-op. */
export function rememberStopSource(source: Source, data: SourceData): void {
  installedData.set(source, data);
}
export function updateStopSource(source: Source, data: SourceData): boolean {
  if (installedData.get(source) === data) return false;
  source.setData(data);
  rememberStopSource(source, data);
  return true;
}

/** Badge/lastSeen changes do not affect dot or symbol properties. Keep both
 * GeoJSON identity and the MapLibre worker source intact for those updates. */
export class StopSourceCache {
  private data: SourceData | undefined;
  private citiesKey = "";

  build(stops: readonly StopWithLines[], exits: readonly StopWithLines[], cities: readonly PointFeature[],
    overrides: ReadonlyMap<string, LabelAnchor>): SourceData {
    const cityKey = JSON.stringify(cities);
    const rows = exits.length ? [...stops, ...exits] : stops;
    const previous = this.data;
    const same = previous && this.citiesKey === cityKey && previous.features.length === cities.length + rows.length &&
      rows.every((stop, index) => {
        const feature = previous.features[cities.length + index];
        const properties = feature.properties;
        return feature.geometry.coordinates[0] === stop.location.lon && feature.geometry.coordinates[1] === stop.location.lat &&
          properties?.id === stop.id && properties?.name === stop.name &&
          properties?.labelAnchor === (overrides.get(stop.id) ?? stop.labelAnchor ?? null);
      });
    if (same) return previous;
    this.citiesKey = cityKey;
    this.data = {type: "FeatureCollection", features: [...cities, ...rows.map(stop => ({
      type: "Feature" as const,
      geometry: {type: "Point" as const, coordinates: [stop.location.lon, stop.location.lat]},
      properties: {id: stop.id, name: stop.name, labelAnchor: overrides.get(stop.id) ?? stop.labelAnchor ?? null},
    }))]};
    return this.data;
  }
}
