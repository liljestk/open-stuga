/** A finite number from untrusted JSON (device payloads, SQLite pragmas, provider responses), or null. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
