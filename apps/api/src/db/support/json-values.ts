import { compareCodeUnits } from "../../text-order.js";

export type JsonValue = string | number | boolean;

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Integration mappings must contain only finite JSON numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") throw new Error("Integration mappings must be JSON-compatible");
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}

/** Top-level mappings are a set; nested arrays retain their declared order. */
export function canonicalIntegrationMappingsJson(mappings: readonly unknown[]): string {
  const canonical = mappings.map(canonicalJsonValue)
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return compareCodeUnits(leftJson, rightJson);
    });
  return JSON.stringify(canonical);
}
