/**
 * Orders strings by UTF-16 code unit, exactly as `Array.prototype.sort()`
 * does without a comparator, so sensor ordering never depends on the locale.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
