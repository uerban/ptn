const SCALE = 1e7;
function encodeBounded(deg: number, maxAbs: number): number | null {
  if (!Number.isFinite(deg) || deg < -maxAbs || deg > maxAbs) return null;
  const s = deg * SCALE;
  const q = Math.sign(s) * Math.round(Math.abs(s)); // half-away, NOT bare Math.round
  if (q < -2147483648 || q > 2147483647) return null;
  return q === 0 ? 0 : q; // normalize -0 so .toBe(0) holds
}
export const encodeLatE7 = (d: number) => encodeBounded(d, 90);
export const encodeLonE7 = (d: number) => encodeBounded(d, 180);
export const decodeE7 = (e7: number) => e7 / SCALE;
