const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** A cloud provider answered with an error status; `providerCode` is its machine-readable reason when it sent one. */
export class ProviderRequestError extends Error {
  constructor(readonly status: number, readonly providerCode: string | null, message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

export interface OAuthTokens extends AccessToken {
  refreshToken: string;
}

/** One CSV file to place in `folder` (path segments under the app's own area), keeping the newest `retentionCount`. */
export interface CloudExportFile {
  folder: string[];
  name: string;
  content: string;
  retentionCount: number;
}

export function formBody(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function recordField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Where the provider explains a failure: OAuth `error`, Dropbox `error_summary`, or Google `error.status`. */
function providerErrorCode(body: Record<string, unknown>): string | null {
  const oauth = stringField(body, "error");
  if (oauth) return oauth;
  const summary = stringField(body, "error_summary");
  if (summary) return summary.replace(/\/\.*$/u, "");
  const nested = recordField(body, "error");
  return stringField(nested, "status") ?? stringField(nested, "message");
}

function parsedBody(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function boundedText(response: Response, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error(`${label} sent an oversized response`);
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${label} sent an oversized response`);
  return text;
}

/** Sends one provider request and returns the response, throwing a ProviderRequestError for any non-2xx answer. */
export async function providerRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  options: { upload?: boolean } = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(options.upload ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.ok) return response;
  const code = providerErrorCode(parsedBody(await boundedText(response, label).catch(() => "")));
  throw new ProviderRequestError(response.status, code, `${label} answered ${response.status}${code ? ` (${code.slice(0, 120)})` : ""}`);
}

/** Like providerRequest, then reads the JSON object body. */
export async function providerJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  const response = await providerRequest(fetchImpl, url, init, label);
  return parsedBody(await boundedText(response, label));
}

/** Reads an OAuth access-token response; a missing lifetime counts as one hour. */
export function tokenResponse(body: Record<string, unknown>, label: string, now: number): AccessToken {
  const accessToken = stringField(body, "access_token");
  const expiresIn = Number(body.expires_in);
  if (!accessToken) throw new Error(`${label} did not return an access token`);
  return { accessToken, expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1_000 : 3_600_000) };
}

/** Reads the first token response of a sign-in, which must also carry the long-lived refresh token. */
export function refreshableTokens(body: Record<string, unknown>, label: string, now: number): OAuthTokens {
  const refreshToken = stringField(body, "refresh_token");
  if (!refreshToken) throw new Error(`${label} did not return a refresh token`);
  return { ...tokenResponse(body, label, now), refreshToken };
}

/** Newest first by timestamp, then by name, so retention keeps the most recent files. */
export function filesBeyondRetention<T extends { name: string; modifiedAt: number }>(files: T[], retentionCount: number): T[] {
  return [...files]
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name))
    .slice(retentionCount);
}
