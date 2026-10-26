/**
 * Orders strings by UTF-16 code unit, exactly as `Array.prototype.sort()`
 * does without a comparator. Canonical JSON depends on this order, so peers
 * must never sort keys with a locale-aware comparison.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
