

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError("Expected a positive integer");
  return Math.min(value, maximum);
}

export function timeoutValue(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new RangeError("timeoutMs must be a non-negative integer");
  return value;
}

export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The telemetry query was aborted", "AbortError");
}
