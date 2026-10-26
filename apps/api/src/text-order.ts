/**
 * Orders strings by UTF-16 code unit, exactly as `Array.prototype.sort()`
 * does without a comparator. Use it where the order feeds keys, hashes or
 * canonical JSON and must not depend on the runtime locale.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
