/** Historical city identifiers resolve without discarding their saved data. */
export function canonicalCityId(cityId: string): string {
  return cityId === "gdansk" ? "tricity" : cityId;
}
