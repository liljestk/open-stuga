/**
 * Increase of a monotonic counter between two consecutive readings.
 *
 * A decrease is a counter reset: the meter restarted from zero, so the new
 * reading is what accumulated since the restart (the convention of
 * Prometheus `increase()`). A negative restart value carries no usable
 * increment. This is the only reset rule in Stugu; the archive SQL applies
 * the same expression and the parity harness holds the two together.
 */
export function counterIncrement(previous: number, current: number): { increment: number; reset: boolean } {
  return current >= previous
    ? { increment: current - previous, reset: false }
    : { increment: Math.max(0, current), reset: true };
}

/** Total increase across chronologically ordered counter readings; undefined below two readings. */
export function counterDelta(ordered: readonly number[]): { delta: number | null; resets: number } {
  if (ordered.length < 2) return { delta: null, resets: 0 };
  let delta = 0;
  let resets = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const step = counterIncrement(ordered[index - 1]!, ordered[index]!);
    delta += step.increment;
    if (step.reset) resets += 1;
  }
  return { delta, resets };
}
