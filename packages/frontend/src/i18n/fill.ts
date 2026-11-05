/**
 * Fill `{name}` placeholders in one pass, inserting values literally: a
 * headsign or stop name is never read as a replace pattern (`$&`) or as
 * another placeholder. A placeholder without a value is left as it is.
 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
