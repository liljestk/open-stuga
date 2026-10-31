import {
  filesBeyondRetention,
  formBody,
  providerJson,
  providerRequest,
  ProviderRequestError,
  recordField,
  refreshableTokens,
  stringField,
  tokenResponse,
  type AccessToken,
  type CloudExportFile,
  type OAuthTokens,
} from "./provider-http.js";

/**
 * Google Drive through the device sign-in ("TVs and Limited Input devices" OAuth client) with the
 * non-sensitive drive.file scope: Stugu can only see and change the files and folders it created.
 */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
/** The top-level My Drive folder that holds every Stugu export. */
export const GOOGLE_DRIVE_ROOT_FOLDER = "Stugu";
const LABEL = "Google Drive";
const MAX_LIST_PAGES = 20;

export interface GoogleDeviceSignIn {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}

type GoogleDeviceWaitState = "pending" | "slow-down" | "denied" | "expired";

export type GoogleDevicePoll =
  | { state: GoogleDeviceWaitState }
  | { state: "approved"; tokens: OAuthTokens };

interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function queryLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export async function startGoogleDeviceSignIn(
  fetchImpl: typeof fetch,
  input: { clientId: string; now: number },
): Promise<GoogleDeviceSignIn> {
  const body = await providerJson(fetchImpl, DEVICE_CODE_URL, {
    method: "POST",
    body: formBody({ client_id: input.clientId, scope: GOOGLE_DRIVE_SCOPE }),
  }, LABEL);
  const deviceCode = stringField(body, "device_code");
  const userCode = stringField(body, "user_code");
  const verificationUrl = stringField(body, "verification_url") ?? stringField(body, "verification_uri");
  if (!deviceCode || !userCode || !verificationUrl?.startsWith("https://")) throw new Error(`${LABEL} did not return a sign-in code`);
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresAt: input.now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1_000 : 30 * 60_000),
    intervalMs: (Number.isFinite(interval) && interval >= 1 ? interval : 5) * 1_000,
  };
}

const PENDING_POLL_STATES: Partial<Record<string, GoogleDeviceWaitState>> = {
  authorization_pending: "pending",
  slow_down: "slow-down",
  access_denied: "denied",
  expired_token: "expired",
};

/** One token-endpoint poll; Google answers "authorization_pending" until the owner approves on their phone or computer. */
export async function pollGoogleDeviceSignIn(
  fetchImpl: typeof fetch,
  input: GoogleClient & { deviceCode: string; now: number },
): Promise<GoogleDevicePoll> {
  try {
    const body = await providerJson(fetchImpl, TOKEN_URL, {
      method: "POST",
      body: formBody({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }, LABEL);
    return { state: "approved", tokens: refreshableTokens(body, LABEL, input.now) };
  } catch (error) {
    const state = error instanceof ProviderRequestError && error.providerCode ? PENDING_POLL_STATES[error.providerCode] : undefined;
    if (state) return { state };
    throw error;
  }
}

export async function refreshGoogleToken(
  fetchImpl: typeof fetch,
  input: GoogleClient & { refreshToken: string; now: number },
): Promise<AccessToken> {
  const body = await providerJson(fetchImpl, TOKEN_URL, {
    method: "POST",
    body: formBody({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  }, LABEL);
  return tokenResponse(body, LABEL, input.now);
}

export async function googleAccountLabel(fetchImpl: typeof fetch, accessToken: string): Promise<string | null> {
  const body = await providerJson(fetchImpl, `${DRIVE_URL}/about?fields=user(emailAddress,displayName)`, { headers: bearer(accessToken) }, LABEL);
  const user = recordField(body, "user");
  return stringField(user, "emailAddress") ?? stringField(user, "displayName");
}

export async function revokeGoogleToken(fetchImpl: typeof fetch, token: string): Promise<void> {
  await providerRequest(fetchImpl, REVOKE_URL, { method: "POST", body: formBody({ token }) }, LABEL);
}

async function ensureFolder(fetchImpl: typeof fetch, accessToken: string, name: string, parentId: string): Promise<string> {
  const query = `name = ${queryLiteral(name)} and mimeType = ${queryLiteral(FOLDER_MIME_TYPE)} and ${queryLiteral(parentId)} in parents and trashed = false`;
  const found = await providerJson(fetchImpl, `${DRIVE_URL}/files?spaces=drive&pageSize=10&fields=files(id)&q=${encodeURIComponent(query)}`, {
    headers: bearer(accessToken),
  }, LABEL);
  const first = Array.isArray(found.files) ? found.files[0] as Record<string, unknown> | undefined : undefined;
  const existing = first ? stringField(first, "id") : null;
  if (existing) return existing;
  const created = await providerJson(fetchImpl, `${DRIVE_URL}/files?fields=id`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] }),
  }, LABEL);
  const id = stringField(created, "id");
  if (!id) throw new Error(`${LABEL} did not create the ${name} folder`);
  return id;
}

async function listFiles(fetchImpl: typeof fetch, accessToken: string, folderId: string): Promise<Array<{ id: string; name: string; modifiedAt: number }>> {
  const query = `${queryLiteral(folderId)} in parents and trashed = false and mimeType != ${queryLiteral(FOLDER_MIME_TYPE)}`;
  const files: Array<{ id: string; name: string; modifiedAt: number }> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url = `${DRIVE_URL}/files?spaces=drive&pageSize=1000&fields=nextPageToken,files(id,name,createdTime)&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const body = await providerJson(fetchImpl, url, { headers: bearer(accessToken) }, LABEL);
    for (const entry of Array.isArray(body.files) ? body.files as Array<Record<string, unknown>> : []) {
      const id = stringField(entry, "id");
      const name = stringField(entry, "name");
      if (id && name?.endsWith(".csv")) files.push({ id, name, modifiedAt: Date.parse(stringField(entry, "createdTime") ?? "") || 0 });
    }
    pageToken = stringField(body, "nextPageToken");
    if (!pageToken) break;
  }
  return files;
}

/** Uploads one export under My Drive › Stugu › <folder…> and removes this schedule's files beyond its retention count. */
export async function uploadToGoogleDrive(fetchImpl: typeof fetch, accessToken: string, file: CloudExportFile): Promise<void> {
  let folderId = await ensureFolder(fetchImpl, accessToken, GOOGLE_DRIVE_ROOT_FOLDER, "root");
  for (const segment of file.folder) folderId = await ensureFolder(fetchImpl, accessToken, segment, folderId);
  const content = Buffer.from(file.content, "utf8");
  const session = await providerRequest(fetchImpl, `${UPLOAD_URL}/files?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: {
      ...bearer(accessToken),
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "text/csv",
      "x-upload-content-length": String(content.byteLength),
    },
    body: JSON.stringify({ name: file.name, parents: [folderId], mimeType: "text/csv" }),
  }, LABEL);
  const location = session.headers.get("location");
  if (!location?.startsWith(`${UPLOAD_URL}/`)) throw new Error(`${LABEL} did not open an upload session`);
  await providerRequest(fetchImpl, location, { method: "PUT", headers: { "content-type": "text/csv" }, body: content }, LABEL, { upload: true });
  for (const entry of filesBeyondRetention(await listFiles(fetchImpl, accessToken, folderId), file.retentionCount)) {
    await providerRequest(fetchImpl, `${DRIVE_URL}/files/${encodeURIComponent(entry.id)}`, { method: "DELETE", headers: bearer(accessToken) }, LABEL);
  }
}
