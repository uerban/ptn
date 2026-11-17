const MAX_BYTES = 2 * 1024 * 1024;

/** JSON-wire values only. Optional object fields may be absent; array holes,
 * non-finite numbers and executable values must not silently become evidence. */
export function wire<T>(value: T): T {
  const text = JSON.stringify(value, function (_key, item) {
    if ((typeof item === "number" && !Number.isFinite(item)) || typeof item === "function"
        || typeof item === "symbol" || (item === undefined && Array.isArray(this))) {
      throw new Error("Finalization capture requires finite JSON-wire values");
    }
    return item;
  });
  if (text === undefined || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("Finalization capture exceeds JSON-wire limit");
  return JSON.parse(text) as T;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
