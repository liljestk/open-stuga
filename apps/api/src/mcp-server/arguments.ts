import { mcpIsoDate } from "../mcp-validation.js";

export function objectArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A required, non-blank MCP tool argument, trimmed like the HTTP body fields. */
export function requiredToolString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

export function optionalToolString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function mcpDateTime(args: Record<string, unknown>, key: string, fallback: Date): string {
  const value = optionalToolString(args, key);
  return value === undefined ? fallback.toISOString() : mcpIsoDate(value, key);
}
