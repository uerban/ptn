const POI_CITY_MAPPING: Record<string, string[]> = {
  // No "sopot": the Gdańsk (to 54.45°N) and Gdynia (from 54.45°N) corpora
  // already cover all of Sopot. Its separate build is still checked against
  // the k floor, but the client avoids downloading overlapping corpora.
  tricity: ["gdansk", "gdynia"],
};

export function poiCityIds(frontendCityId: string): string[] {
  return POI_CITY_MAPPING[frontendCityId] ?? [frontendCityId];
}
