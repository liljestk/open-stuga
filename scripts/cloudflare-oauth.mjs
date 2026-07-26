import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const CLOUDFLARE_OAUTH_AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOCATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
export const DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI =
  "http://127.0.0.1:8976/cloudflare/oauth/callback";
export const CLOUDFLARE_SETUP_OAUTH_SCOPES = Object.freeze([
  "access.write",
  "argotunnel.write",
  "dns.write",
]);

const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function safeOAuthError(value) {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/iu.test(value)
    ? value
    : "authorization_failed";
}

export function validateCloudflareOAuthClientId(value) {
  const clientId = typeof value === "string" ? value.trim() : "";
  if (clientId.length < 8
    || clientId.length > 512
    || /[^\x21-\x7e]/u.test(clientId)) {
    throw new Error("Cloudflare OAuth client ID is invalid");
  }
  return clientId;
}

export function validateCloudflareOAuthRedirectUri(value) {
  let redirect;
  try {
    redirect = new URL(value);
  } catch {
    throw new Error("Cloudflare OAuth redirect URI is invalid");
  }
  const loopback = redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]";
  const port = Number(redirect.port);
  if (redirect.protocol !== "http:"
    || !loopback
    || !Number.isInteger(port)
    || port < 1024
    || port > 65_535
    || redirect.username
    || redirect.password
    || redirect.search
    || redirect.hash
    || redirect.pathname === "/") {
    throw new Error(
      "Cloudflare OAuth redirect URI must be an explicit unprivileged loopback HTTP URL",
    );
  }
  return redirect;
}

export function cloudflareSetupOAuthScopes(discoverZone = false) {
  return discoverZone
    ? [...CLOUDFLARE_SETUP_OAUTH_SCOPES, "zone.read"]
    : [...CLOUDFLARE_SETUP_OAUTH_SCOPES];
}

export function createPkceChallenge(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createCloudflareAuthorizationUrl({
  authorizationEndpoint = CLOUDFLARE_OAUTH_AUTHORIZATION_ENDPOINT,
  clientId,
  codeChallenge,
  redirectUri,
  scopes,
  state,
}) {
  const endpoint = new URL(authorizationEndpoint);
  const scopeList = Array.isArray(scopes) ? scopes : [];
  if (endpoint.protocol !== "https:" || scopeList.length === 0
    || scopeList.some((scope) => !/^[a-z0-9][a-z0-9._:-]{1,127}$/u.test(scope))) {
    throw new Error("Cloudflare OAuth authorization settings are invalid");
  }
  endpoint.search = new URLSearchParams({
    client_id: validateCloudflareOAuthClientId(clientId),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: validateCloudflareOAuthRedirectUri(redirectUri).href,
    response_type: "code",
    scope: scopeList.join(" "),
    state,
  }).toString();
  return endpoint.href;
}

export async function openExternalUrl(url, dependencies = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Refusing to open a non-HTTP URL");
  }
  const platform = dependencies.platform ?? process.platform;
  const spawner = dependencies.spawner ?? spawn;
  const [command, args] = platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", target.href]]
    : platform === "darwin"
      ? ["open", [target.href]]
      : ["xdg-open", [target.href]];

  await new Promise((resolve, reject) => {
    const child = spawner(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function callbackHtml(approved) {
  const title = approved ? "Cloudflare approved" : "Cloudflare approval stopped";
  const message = approved
    ? "Cloudflare approved Stugu setup. Return to the terminal."
    : "Cloudflare did not approve Stugu setup. Return to the terminal.";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function sendCallbackResponse(response, status, approved) {
  const body = callbackHtml(approved);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function createCallbackWaiter(redirect, expectedState, dependencies = {}) {
  const serverFactory = dependencies.serverFactory ?? createServer;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15 * 60_000) {
    throw new Error("Cloudflare OAuth callback timeout is invalid");
  }

  let complete = false;
  let resolveCode;
  let rejectCode;
  const code = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = serverFactory((request, response) => {
    if (complete) {
      sendCallbackResponse(response, 410, false);
      return;
    }
    if (request.method !== "GET" || request.headers.host !== redirect.host) {
      sendCallbackResponse(response, 400, false);
      return;
    }
    const callback = new URL(request.url ?? "/", redirect.origin);
    if (callback.pathname !== redirect.pathname
      || !safeEqual(callback.searchParams.get("state") ?? "", expectedState)) {
      sendCallbackResponse(response, 400, false);
      return;
    }

    const oauthError = callback.searchParams.get("error");
    if (oauthError) {
      complete = true;
      sendCallbackResponse(response, 400, false);
      rejectCode(new Error(`Cloudflare approval was not granted (${safeOAuthError(oauthError)})`));
      return;
    }
    const authorizationCode = callback.searchParams.get("code") ?? "";
    if (!authorizationCode
      || authorizationCode.length > 4096
      || /[\u0000-\u001f\u007f]/u.test(authorizationCode)) {
      sendCallbackResponse(response, 400, false);
      return;
    }
    complete = true;
    sendCallbackResponse(response, 200, true);
    resolveCode(authorizationCode);
  });

  let timer;
  const listen = () => new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    const host = redirect.hostname === "[::1]" ? "::1" : "127.0.0.1";
    server.listen(Number(redirect.port), host, () => {
      server.off("error", onError);
      server.on("error", (error) => {
        if (!complete) {
          complete = true;
          rejectCode(error);
        }
      });
      timer = setTimeout(() => {
        if (!complete) {
          complete = true;
          rejectCode(new Error("Cloudflare approval timed out"));
        }
      }, timeoutMs);
      timer.unref?.();
      resolve();
    });
  });
  const close = () => new Promise((resolve) => {
    if (timer) clearTimeout(timer);
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  return { close, code, listen };
}

async function boundedText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OAUTH_RESPONSE_BYTES) {
    throw new Error("Cloudflare OAuth returned an oversized response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OAUTH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Cloudflare OAuth returned an oversized response");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function exchangeAuthorizationCode({
  clientId,
  code,
  codeVerifier,
  redirectUri,
  scopes,
}, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const tokenEndpoint = dependencies.tokenEndpoint ?? CLOUDFLARE_OAUTH_TOKEN_ENDPOINT;
  const response = await fetcher(tokenEndpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const text = await boundedText(response);
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Cloudflare OAuth returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(
      `Cloudflare OAuth token exchange failed (HTTP ${response.status}, ${safeOAuthError(payload?.error)})`,
    );
  }
  const accessToken = typeof payload?.access_token === "string"
    ? payload.access_token.trim()
    : "";
  if (accessToken.length < 32
    || /[\r\n]/u.test(accessToken)
    || (payload?.token_type && String(payload.token_type).toLowerCase() !== "bearer")) {
    throw new Error("Cloudflare OAuth did not return one valid bearer token");
  }
  if (typeof payload.scope === "string") {
    const granted = new Set(payload.scope.split(/\s+/u).filter(Boolean));
    const missing = scopes.find((scope) => !granted.has(scope));
    if (missing) {
      try {
        await revokeAccessToken({ accessToken, clientId }, dependencies);
      } catch {
        // The caller receives no token. Cloudflare access tokens are short-lived
        // and this flow never requests a refresh token.
      }
      throw new Error(`Cloudflare OAuth approval omitted the required ${missing} permission`);
    }
  }
  return {
    accessToken,
    expiresIn: Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : null,
  };
}

export async function revokeAccessToken({ accessToken, clientId }, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const revocationEndpoint = dependencies.revocationEndpoint
    ?? CLOUDFLARE_OAUTH_REVOCATION_ENDPOINT;
  const response = await fetcher(revocationEndpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      token: accessToken,
      token_type_hint: "access_token",
    }),
  });
  await boundedText(response);
  if (!response.ok) {
    throw new Error(`Cloudflare OAuth revocation failed (HTTP ${response.status})`);
  }
}

export async function authorizeCloudflareSetup(options, dependencies = {}) {
  const clientId = validateCloudflareOAuthClientId(options.clientId);
  const redirect = validateCloudflareOAuthRedirectUri(
    options.redirectUri ?? DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI,
  );
  const scopes = options.scopes ?? cloudflareSetupOAuthScopes(false);
  const randomSource = dependencies.randomBytes ?? randomBytes;
  const state = base64Url(randomSource(32));
  const codeVerifier = base64Url(randomSource(48));
  const codeChallenge = createPkceChallenge(codeVerifier);
  const authorizationUrl = createCloudflareAuthorizationUrl({
    authorizationEndpoint: dependencies.authorizationEndpoint,
    clientId,
    codeChallenge,
    redirectUri: redirect.href,
    scopes,
    state,
  });
  const callback = createCallbackWaiter(redirect, state, {
    serverFactory: dependencies.serverFactory,
    timeoutMs: dependencies.callbackTimeoutMs,
  });
  const logger = dependencies.logger ?? console;
  const browserOpener = dependencies.openBrowser ?? openExternalUrl;
  const callbackResult = callback.code.then(
    (code) => ({ code, error: null }),
    (error) => ({ code: null, error }),
  );

  await callback.listen();
  try {
    try {
      await browserOpener(authorizationUrl);
      logger.log("[setup] Continue in the Cloudflare approval window.");
    } catch {
      logger.log(`[setup] Open this Cloudflare approval URL:\n${authorizationUrl}`);
    }
    const result = await callbackResult;
    if (result.error) throw result.error;
    const grant = await exchangeAuthorizationCode({
      clientId,
      code: result.code,
      codeVerifier,
      redirectUri: redirect.href,
      scopes,
    }, dependencies);
    let revoked = false;
    return {
      accessToken: grant.accessToken,
      expiresIn: grant.expiresIn,
      async revoke() {
        if (revoked) return;
        await revokeAccessToken({
          accessToken: grant.accessToken,
          clientId,
        }, dependencies);
        revoked = true;
      },
    };
  } finally {
    await callback.close();
  }
}
