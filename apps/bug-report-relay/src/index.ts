import { createSign, timingSafeEqual } from "node:crypto";
import {
  BugReportValidationError,
  normalizeBugReportInput,
  type BugReportRelayPayload,
} from "@climate-twin/contracts";

const MAX_BODY_BYTES = 32 * 1_024;
const GITHUB_API_VERSION = "2026-03-10";
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const CONFIG_VALUE = /^[A-Za-z0-9_.-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class RelayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function response(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

async function bodyText(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RelayError(413, "PAYLOAD_TOO_LARGE", "The report is too large");
  }
  if (!request.body) throw new RelayError(400, "INVALID_BODY", "A JSON body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RelayError(413, "PAYLOAD_TOO_LARGE", "The report is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError(400, "INVALID_BODY", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}

function githubObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function relayPayload(value: unknown): BugReportRelayPayload {
  const raw = objectValue(value);
  const allowed = new Set(["description", "diagnostics", "contactEmail", "reportId", "submittedAt", "serverVersion"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new RelayError(400, "INVALID_REPORT", "The report contains unknown fields");
  }
  let input;
  try {
    input = normalizeBugReportInput({
      description: raw.description,
      ...(raw.diagnostics === undefined ? {} : { diagnostics: raw.diagnostics }),
      ...(raw.contactEmail === undefined ? {} : { contactEmail: raw.contactEmail }),
    });
  } catch (error) {
    if (error instanceof BugReportValidationError) throw new RelayError(400, "INVALID_REPORT", error.message);
    throw error;
  }
  if (typeof raw.reportId !== "string" || !UUID.test(raw.reportId)) {
    throw new RelayError(400, "INVALID_REPORT", "reportId is invalid");
  }
  if (typeof raw.submittedAt !== "string" || !Number.isFinite(Date.parse(raw.submittedAt))) {
    throw new RelayError(400, "INVALID_REPORT", "submittedAt is invalid");
  }
  const submittedAt = new Date(raw.submittedAt).toISOString();
  if (Math.abs(Date.now() - Date.parse(submittedAt)) > MAX_CLOCK_SKEW_MS) {
    throw new RelayError(400, "STALE_REPORT", "submittedAt is outside the accepted window");
  }
  if (typeof raw.serverVersion !== "string" || raw.serverVersion.length < 1 || raw.serverVersion.length > 100) {
    throw new RelayError(400, "INVALID_REPORT", "serverVersion is invalid");
  }
  return { ...input, reportId: raw.reportId, submittedAt, serverVersion: raw.serverVersion };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  return timingSafeEqual(leftHash, rightHash);
}

async function authenticate(request: Request, env: Env): Promise<string> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/u);
  if (!match || !(await safeEqual(match[1]!, env.RELAY_AUTH_TOKEN))) {
    throw new RelayError(401, "UNAUTHORIZED", "A valid relay credential is required");
  }
  return match[1]!;
}

function assertConfig(env: Env): void {
  if (!CONFIG_VALUE.test(env.GITHUB_OWNER) || !CONFIG_VALUE.test(env.GITHUB_REPOSITORY)) {
    throw new RelayError(500, "INVALID_CONFIGURATION", "The repository configuration is invalid");
  }
  if (!/^\d+$/u.test(env.GITHUB_APP_ID) || !/^\d+$/u.test(env.GITHUB_INSTALLATION_ID)) {
    throw new RelayError(500, "INVALID_CONFIGURATION", "The GitHub App configuration is invalid");
  }
  if (env.GITHUB_API_URL !== "https://api.github.com") {
    throw new RelayError(500, "INVALID_CONFIGURATION", "The GitHub API origin is invalid");
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function githubAppJwt(env: Env): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(env.GITHUB_PRIVATE_KEY, "base64url")}`;
}

async function githubJson(
  env: Env,
  fetcher: typeof fetch,
  path: string,
  authorization: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let githubResponse: Response;
  try {
    githubResponse = await fetcher(`${env.GITHUB_API_URL}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "content-type": "application/json",
        "user-agent": "stugu-bug-report-relay",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RelayError(502, "GITHUB_REQUEST_FAILED", "GitHub could not be reached");
  }
  if (!githubResponse.ok) throw new RelayError(502, "GITHUB_REQUEST_FAILED", "GitHub rejected the report");
  try {
    return await githubResponse.json();
  } catch {
    throw new RelayError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid response");
  }
}

async function installationToken(env: Env, fetcher: typeof fetch): Promise<string> {
  const result = githubObject(await githubJson(
    env,
    fetcher,
    `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    `Bearer ${githubAppJwt(env)}`,
    { repositories: [env.GITHUB_REPOSITORY], permissions: { issues: "write" } },
  ));
  if (typeof result.token !== "string" || result.token.length < 20 || result.token.length > 2_000) {
    throw new RelayError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid installation token");
  }
  return result.token;
}

function markdownText(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/([`*_{}\[\]()#+\-.!|>])/gu, "\\$1").replace(/@/gu, "＠").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function htmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/@/gu, "&#64;");
}

function issueTitle(report: BugReportRelayPayload): string {
  const firstLine = report.description.split(/\r?\n/u, 1)[0]!.replace(/\s+/gu, " ").trim();
  return `[App report] ${firstLine.slice(0, 80).replace(/@/gu, "＠").replace(/[<>]/gu, "")}`;
}

function issueBody(report: BugReportRelayPayload): string {
  const technical = JSON.stringify({
    reportId: report.reportId,
    submittedAt: report.submittedAt,
    serverVersion: report.serverVersion,
    ...(report.diagnostics ? { diagnostics: report.diagnostics } : {}),
  }, null, 2);
  const contact = report.contactEmail
    ? `Reporter consented to contact at <code>${htmlText(report.contactEmail)}</code>.`
    : "Reporter did not provide contact permission.";
  return [
    "## What happened",
    "",
    markdownText(report.description),
    "",
    "## Technical details",
    "",
    "<details><summary>Submitted diagnostics</summary>",
    "",
    `<pre>${htmlText(technical)}</pre>`,
    "</details>",
    "",
    "## Contact permission",
    "",
    contact,
  ].join("\n");
}

async function createIssue(env: Env, fetcher: typeof fetch, report: BugReportRelayPayload): Promise<number> {
  const token = await installationToken(env, fetcher);
  const result = githubObject(await githubJson(
    env,
    fetcher,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}/issues`,
    `Bearer ${token}`,
    {
      title: issueTitle(report),
      body: issueBody(report),
      ...(env.GITHUB_LABEL.trim() ? { labels: [env.GITHUB_LABEL.trim().slice(0, 50)] } : {}),
    },
  ));
  if (!Number.isSafeInteger(result.number) || (result.number as number) < 1) {
    throw new RelayError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid issue");
  }
  return result.number as number;
}

export async function handleRequest(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  let reportId: string | undefined;
  try {
    const url = new URL(request.url);
    if (url.pathname !== "/reports") throw new RelayError(404, "NOT_FOUND", "Not found");
    if (request.method !== "POST") throw new RelayError(405, "METHOD_NOT_ALLOWED", "Only POST is supported");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new RelayError(415, "JSON_REQUIRED", "An application/json body is required");
    }
    const token = await authenticate(request, env);
    assertConfig(env);
    const key = Buffer.from(await digest(token)).toString("base64url");
    const limit = await env.BUG_REPORT_RATE_LIMITER.limit({ key });
    if (!limit.success) throw new RelayError(429, "RATE_LIMITED", "Please wait before sending another report");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await bodyText(request));
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(400, "INVALID_JSON", "The request body is not valid JSON");
    }
    const report = relayPayload(parsed);
    reportId = report.reportId;
    const issueNumber = await createIssue(env, fetcher, report);
    console.log(JSON.stringify({ event: "bug_report_created", reportId, issueNumber }));
    return response(201, { reportId });
  } catch (error) {
    const relayError = error instanceof RelayError
      ? error
      : new RelayError(500, "INTERNAL_ERROR", "The report could not be processed");
    console.error(JSON.stringify({ event: "bug_report_failed", code: relayError.code, status: relayError.status, ...(reportId ? { reportId } : {}) }));
    return response(relayError.status, { error: { code: relayError.code, message: relayError.message } });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
