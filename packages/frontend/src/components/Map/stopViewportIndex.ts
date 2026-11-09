import type {StopWithLines} from "@pt/shared";

interface Bounds {west: number; east: number; south: number; north: number}
interface Point {id: string; lon: number; lat: number; order: number}
const longitude = (value: number) => value >= -180 && value < 180 ? value : ((value + 180) % 360 + 360) % 360 - 180;

/** Geometry only. Query IDs are resolved against the current visible/badge
 * snapshot by the caller, so the index never retains old activity objects. */
export class StopViewportIndex {
  private readonly points: Point[];
  constructor(stops: readonly StopWithLines[]) {
    this.points = stops.flatMap((stop, order) => {
      const {lat, lon} = stop.location;
      return Number.isFinite(lat) && Number.isFinite(lon)
        ? [{id: stop.id, lat, lon: longitude(lon), order}] : [];
    }).sort((a, b) => a.lon - b.lon || a.order - b.order);
  }

  query({west, east, south, north}: Bounds): string[] {
    if (![west, east, south, north].every(Number.isFinite) || south > north) return [];
    const selected: Point[] = [];
    const range = (left: number, right: number) => {
      let lo = 0, hi = this.points.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.points[mid].lon < left) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.points.length && this.points[i].lon <= right; i++) {
        const point = this.points[i];
        if (point.lat >= south && point.lat <= north) selected.push(point);
      }
    };
    if (Math.abs(east - west) >= 360) range(-180, 180);
    else {
      const left = longitude(west), right = longitude(east);
      if (left <= right) range(left, right);
      else { range(left, 180); range(-180, right); }
    }
    // Preserve the original stop order for placement ties and hysteresis.
    return selected.sort((a, b) => a.order - b.order).map(point => point.id);
  }
}
