import { HttpError } from "../../http-error.js";

export function optionalResourceQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

export function dateValue(value: unknown, fallback: Date, field: string): string {
  if (value === undefined) return fallback.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "INVALID_FIELD", `${field} must be an ISO date-time`);
  return new Date(value).toISOString();
}

export function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
}

export function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function boundedQueryInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function optionalQueryNumber(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value))) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be a finite number`);
  }
  return Number(value);
}
