interface CoarsenedRequest {
  snappedCoord: { lat: number; lon: number };
}
interface LatLon {
  lat: number;
  lon: number;
}

const req = {} as CoarsenedRequest;
const pos = {} as LatLon;
