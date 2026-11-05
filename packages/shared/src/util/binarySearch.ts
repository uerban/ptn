/**
 * Returns the index of the first element `e` in `arr` for which
 * `accessor(e) >= target`. If no such element exists, returns `arr.length`.
 *
 * `arr` MUST be sorted ascending by `accessor(e)`. Complexity: O(log n).
 *
 * Accepts any `ArrayLike<T>` — plain arrays, readonly arrays, and typed arrays
 * (e.g. `Uint32Array` from `TileStopColumns.departureSecs`) all work.
 *
 * Use for range-window queries where a sorted array is scanned by time,
 * offset, or any monotonically non-decreasing numeric key.
 */
export function lowerBound<T>(
  arr: ArrayLike<T>,
  target: number,
  accessor: (e: T) => number,
): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (accessor(arr[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
