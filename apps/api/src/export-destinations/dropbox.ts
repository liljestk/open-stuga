import {
  filesBeyondRetention,
  formBody,
  providerJson,
  providerRequest,
  recordField,
  refreshableTokens,
  stringField,
  tokenResponse,
  type AccessToken,
  type CloudExportFile,
  type OAuthTokens,
} from "./provider-http.js";

/**
 * Dropbox with a scoped "App folder" app: files land in Apps/<app name>/ and the app sees nothing else.
 * Sign-in uses PKCE without a redirect URI, so Dropbox shows a code the owner pastes back into Stugu.
 */
const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const API_URL = "https://api.dropboxapi.com/2";
const CONTENT_URL = "https://content.dropboxapi.com/2";
const LABEL = "Dropbox";
const MAX_LIST_PAGES = 20;

interface DropboxFileEntry {
  name: string;
  path: string;
  modifiedAt: number;
}

/** Dropbox-API-Arg is an HTTP header, so every non-ASCII character must be escaped. */
function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function folderPath(segments: string[]): string {
  return `/${segments.join("/")}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function dropboxAuthorizeUrl(appKey: string, codeChallenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeDropboxCode(
  fetchImpl: typeof fetch,
  input: { appKey: string; code: string; codeVerifier: string; now: number },
): Promise<OAuthTokens> {
  const body = await providerJson(fetchImpl, TOKEN_URL, {
    method: "POST",
    body: formBody({ code: input.code, grant_type: "authorization_code", code_verifier: input.codeVerifier, client_id: input.appKey }),
  }, LABEL);
  return refreshableTokens(body, LABEL, input.now);
}

export async function refreshDropboxToken(
  fetchImpl: typeof fetch,
  input: { appKey: string; refreshToken: string; now: number },
): Promise<AccessToken> {
  const body = await providerJson(fetchImpl, TOKEN_URL, {
    method: "POST",
    body: formBody({ grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.appKey }),
  }, LABEL);
  return tokenResponse(body, LABEL, input.now);
}

export async function dropboxAccountLabel(fetchImpl: typeof fetch, accessToken: string): Promise<string | null> {
  const body = await providerJson(fetchImpl, `${API_URL}/users/get_current_account`, { method: "POST", headers: bearer(accessToken) }, LABEL);
  return stringField(body, "email") ?? stringField(recordField(body, "name"), "display_name");
}

export async function revokeDropboxToken(fetchImpl: typeof fetch, accessToken: string): Promise<void> {
  await providerRequest(fetchImpl, `${API_URL}/auth/token/revoke`, { method: "POST", headers: bearer(accessToken) }, LABEL);
}

async function listCsvFiles(fetchImpl: typeof fetch, accessToken: string, path: string): Promise<DropboxFileEntry[]> {
  const files: DropboxFileEntry[] = [];
  let page = await providerJson(fetchImpl, `${API_URL}/files/list_folder`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ path, recursive: false }),
  }, LABEL);
  for (let index = 0; index < MAX_LIST_PAGES; index += 1) {
    for (const entry of Array.isArray(page.entries) ? page.entries as Array<Record<string, unknown>> : []) {
      const name = stringField(entry, "name");
      const entryPath = stringField(entry, "path_lower");
      if (entry[".tag"] !== "file" || !name?.endsWith(".csv") || !entryPath) continue;
      files.push({ name, path: entryPath, modifiedAt: Date.parse(stringField(entry, "server_modified") ?? "") || 0 });
    }
    const cursor = stringField(page, "cursor");
    if (page.has_more !== true || !cursor) break;
    page = await providerJson(fetchImpl, `${API_URL}/files/list_folder/continue`, {
      method: "POST",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify({ cursor }),
    }, LABEL);
  }
  return files;
}

/** Uploads one export into the app folder and removes this schedule's files beyond its retention count. */
export async function uploadToDropbox(fetchImpl: typeof fetch, accessToken: string, file: CloudExportFile): Promise<void> {
  const folder = folderPath(file.folder);
  await providerRequest(fetchImpl, `${CONTENT_URL}/files/upload`, {
    method: "POST",
    headers: {
      ...bearer(accessToken),
      "content-type": "application/octet-stream",
      "dropbox-api-arg": headerJson({ path: `${folder}/${file.name}`, mode: "overwrite", autorename: false, mute: true }),
    },
    body: Buffer.from(file.content, "utf8"),
  }, LABEL, { upload: true });
  const stale = filesBeyondRetention(await listCsvFiles(fetchImpl, accessToken, folder), file.retentionCount);
  for (const entry of stale) {
    await providerRequest(fetchImpl, `${API_URL}/files/delete_v2`, {
      method: "POST",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify({ path: entry.path }),
    }, LABEL);
  }
}
