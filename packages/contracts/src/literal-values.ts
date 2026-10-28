/** True when `value` is one of the listed literals, narrowing it to that union. */
export function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
