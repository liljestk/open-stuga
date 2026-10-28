import { isOneOf } from "@climate-twin/contracts";
import { HttpError } from "./http-error.js";

// Request-body field validators shared by every HTTP route family. A failed
// check is a 400 HttpError: INVALID_BODY, UNKNOWN_FIELD or INVALID_FIELD.

function invalidField(message: string): HttpError {
  return new HttpError(400, "INVALID_FIELD", message);
}

function atMost(maximum: number | undefined): string {
  return maximum === undefined ? "" : ` of at most ${maximum} characters`;
}

export function bodyObject(value: unknown, label = "Request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_BODY", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownFields(body: Record<string, unknown>, allowed: Iterable<string>, label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "UNKNOWN_FIELD", `${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

/** A non-blank string, trimmed; `maximum` bounds the trimmed length. */
export function requiredString(body: Record<string, unknown>, key: string, maximum?: number): string {
  const value = body[key];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || (maximum !== undefined && text.length > maximum)) {
    throw invalidField(`${key} must be a non-empty string${atMost(maximum)}`);
  }
  return text;
}

/** A string as sent, or undefined when absent. */
export function optionalString(body: Record<string, unknown>, key: string, maximum?: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (maximum !== undefined && value.length > maximum)) {
    throw invalidField(`${key} must be a string${atMost(maximum)}`);
  }
  return value;
}

/** A string as sent, null to clear it, or undefined when absent. */
export function nullableString(body: Record<string, unknown>, key: string, maximum?: number): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || (maximum !== undefined && value.length > maximum)) {
    throw invalidField(`${key} must be null or a string${atMost(maximum)}`);
  }
  return value;
}

export function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidField(`${key} must be a finite number`);
  return value;
}

export function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  return body[key] === undefined ? undefined : requiredNumber(body, key);
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidField(`${key} must be a boolean`);
  return value;
}

export function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!isOneOf(value, values)) throw invalidField(`${field} must be one of: ${values.join(", ")}`);
  return value;
}
