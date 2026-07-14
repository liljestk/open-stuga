export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue | undefined }

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(request: Request, maxBytes = 1_500_000): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel("payload limit exceeded"); } catch { /* best-effort stream cancellation */ }
          throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object");
  return value;
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 500,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > maxLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string of at most ${maxLength} characters`);
  }
  return candidate.trim();
}

export function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 500,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length > maxLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a string of at most ${maxLength} characters`);
  }
  return candidate;
}

export function finiteNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number`);
  }
  return value;
}

export function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, "INVALID_FIELD", `Expected an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseStoredJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return Response.json(data, { status, headers });
}

export function empty(status = 204): Response {
  return new Response(null, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(JSON.stringify({
    message: "request failed",
    method: request.method,
    path: new URL(request.url).pathname,
    error: message,
  }));
  return json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } }, 500);
}

export function routeId(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Path contains an invalid encoded identifier");
  }
}
