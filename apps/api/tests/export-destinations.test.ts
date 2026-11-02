import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { PROJECT_CLOUD_EXPORT_APPS } from "../src/config/cloud-export-apps.js";
import type { ExportDestinationSecrets } from "../src/export-destinations/secrets.js";
import { ExportDestinationError, ExportDestinationService } from "../src/export-destinations/service.js";
import { readIntegrationSecrets, updateIntegrationSecrets } from "../src/integration-secrets.js";
import { setupOwner } from "./local-authTestSupport.js";


const DROPBOX_APP_KEY = "stugutestappkey";
const GOOGLE_CLIENT_ID = "1234567890-test.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "test-client-secret";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function header(init: RequestInit | undefined, name: string): string | null {
  return (init?.headers as Record<string, string> | undefined)?.[name] ?? null;
}

/** A small in-memory Dropbox and Google Drive that answers the requests the destination service makes. */
function fakeProviders() {
  const dropboxFiles = new Map<string, { name: string; modified: string }>();
  const driveItems: Array<{ id: string; name: string; parent: string; folder: boolean; createdTime: string }> = [];
  const pendingUploads = new Map<string, { name: string; parent: string }>();
  const revoked: string[] = [];
  const state = { dropboxChallenge: "", devicePolls: 0, approveAfterPolls: 1, nextId: 1, clock: Date.parse("2026-10-31T12:00:00.000Z") };
  const tick = () => new Date(state.clock += 1_000).toISOString();

  const dropbox = (url: string, init: RequestInit = {}): Response => {
    if (url === "https://api.dropboxapi.com/oauth2/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code") {
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (form.get("code") !== "dropbox-code-123" || challenge !== state.dropboxChallenge || form.get("client_id") !== DROPBOX_APP_KEY) {
          return json({ error: "invalid_grant", error_description: "code doesn't exist or has expired" }, 400);
        }
        return json({ access_token: "dbx-access-1", refresh_token: "dbx-refresh-1", expires_in: 14_400, token_type: "bearer" });
      }
      if (form.get("refresh_token") === "dbx-revoked") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "dbx-access-2", expires_in: 14_400, token_type: "bearer" });
    }
    if (url.endsWith("/users/get_current_account")) return json({ email: "owner@example.test", name: { display_name: "Owner" } });
    if (url.endsWith("/auth/token/revoke")) {
      revoked.push(header(init, "authorization") ?? "");
      return json(null);
    }
    if (url === "https://content.dropboxapi.com/2/files/upload") {
      const argument = JSON.parse(header(init, "dropbox-api-arg") ?? "{}") as { path: string };
      dropboxFiles.set(argument.path.toLowerCase(), { name: argument.path.split("/").at(-1)!, modified: tick() });
      return json({ name: argument.path });
    }
    if (url.endsWith("/files/list_folder")) {
      const { path } = JSON.parse(String(init.body)) as { path: string };
      const entries = [...dropboxFiles.entries()].filter(([key]) => key.startsWith(`${path.toLowerCase()}/`))
        .map(([key, file]) => ({ ".tag": "file", name: file.name, path_lower: key, server_modified: file.modified }));
      return json({ entries, cursor: "c1", has_more: false });
    }
    if (url.endsWith("/files/delete_v2")) {
      dropboxFiles.delete((JSON.parse(String(init.body)) as { path: string }).path);
      return json({ metadata: {} });
    }
    return json({ error_summary: "unexpected/" }, 404);
  };

  const google = (url: string, init: RequestInit = {}): Response => {
    if (url === "https://oauth2.googleapis.com/device/code") {
      return json({ device_code: "device-1", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1_800, interval: 5 });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "refresh_token") return json({ access_token: "g-access-2", expires_in: 3_599 });
      state.devicePolls += 1;
      if (state.devicePolls <= state.approveAfterPolls) return json({ error: "authorization_pending" }, 428);
      return json({ access_token: "g-access-1", refresh_token: "g-refresh-1", expires_in: 3_599 });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      revoked.push(new URLSearchParams(String(init.body)).get("token") ?? "");
      return json({});
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/about")) return json({ user: { emailAddress: "owner@gmail.example" } });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?") && (init.method ?? "GET") === "GET") {
      const query = new URL(url).searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/u.exec(query)?.[1];
      const name = /name = '([^']+)'/u.exec(query)?.[1];
      const folders = query.includes(`mimeType = '${FOLDER_MIME_TYPE}'`);
      const files = driveItems.filter((item) => item.parent === parent && item.folder === folders && (!name || item.name === name));
      return json({ files: files.map(({ id, name: itemName, createdTime }) => ({ id, name: itemName, createdTime })) });
    }
    if (url === "https://www.googleapis.com/drive/v3/files?fields=id" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      const id = `folder-${state.nextId++}`;
      driveItems.push({ id, name: body.name, parent: body.parents[0]!, folder: true, createdTime: tick() });
      return json({ id });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      const session = `session-${state.nextId++}`;
      pendingUploads.set(session, { name: body.name, parent: body.parents[0]! });
      return json({}, 200, { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${session}` });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?") && init.method === "PUT") {
      const upload = pendingUploads.get(new URL(url).searchParams.get("upload_id") ?? "")!;
      const id = `file-${state.nextId++}`;
      driveItems.push({ id, name: upload.name, parent: upload.parent, folder: false, createdTime: tick() });
      return json({ id });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/") && init.method === "DELETE") {
      const id = decodeURIComponent(url.split("/").at(-1)!);
      driveItems.splice(driveItems.findIndex((item) => item.id === id), 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: { status: "NOT_FOUND" } }, 404);
  };

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return url.includes("dropbox") ? dropbox(url, init) : google(url, init);
  });
  return { fetchImpl, state, dropboxFiles, driveItems, revoked };
}


const OWNER = "owner-1";
const ADMIN = "admin-1";

describe("export destinations", () => {
  const directories: string[] = [];
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await runtime?.close();
    runtime = null;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * `apps` says where configured provider apps come from: the deployment's variables or the built-in apps.
   * `departed` holds the people who are no longer an Owner or Admin.
   */
  function fixture(options: { nas?: boolean; configured?: boolean; apps?: "environment" | "built-in"; stored?: ExportDestinationSecrets } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "stugu-export-destinations-"));
    directories.push(directory);
    const secretsFile = join(directory, "integration-secrets.json");
    const providers = fakeProviders();
    const departed = new Set<string>();
    const configured = options.configured ?? true;
    const appSource = configured ? options.apps ?? "environment" : null;
    const service = new ExportDestinationService({
      secretsFile,
      stored: options.stored ?? null,
      systemStorage: {
        status: () => ({ settings: {
          timeseries: { kind: "managed", path: null },
          backups: options.nas ? { kind: "nas-path", path: "/mnt/stugu/nas" } : { kind: "managed", path: null },
        } }),
      } as never,
      mayHoldAccounts: (userId) => !departed.has(userId),
      dropboxAppKey: configured ? DROPBOX_APP_KEY : null,
      googleDriveClientId: configured ? GOOGLE_CLIENT_ID : null,
      googleDriveClientSecret: configured ? GOOGLE_CLIENT_SECRET : null,
      dropboxAppSource: appSource,
      googleDriveAppSource: appSource,
      fetchImpl: providers.fetchImpl,
      now: () => new Date("2026-10-31T12:00:00.000Z"),
    });
    return { service, secretsFile, providers, departed };
  }

  async function connectDropbox(context: ReturnType<typeof fixture>, userId = OWNER) {
    const started = await context.service.connect(userId, "dropbox");
    const authorize = new URL(started.connection!.url);
    context.providers.state.dropboxChallenge = authorize.searchParams.get("code_challenge")!;
    return context.service.submitCode(userId, "dropbox", { connectionId: started.connection!.id, code: "dropbox-code-123" });
  }

  it("defaults to the NAS and marks providers without an app ID as unavailable", () => {
    const { service } = fixture({ nas: true, configured: false });
    expect(service.status(OWNER)).toEqual({
      selected: "nas",
      ready: true,
      nasConnected: true,
      accounts: [
        { provider: "dropbox", available: false, appSource: null, connected: false, accountLabel: null, connectedAt: null },
        { provider: "google-drive", available: false, appSource: null, connected: false, accountLabel: null, connectedAt: null },
      ],
      connection: null,
    });
    expect(fixture({ nas: false }).service.readyFor(OWNER)).toBe(false);
    expect(service.selectedFor(null)).toBe("nas");
    return expect(service.connect(OWNER, "dropbox")).rejects.toMatchObject({ status: 409, code: "CLOUD_EXPORT_PROVIDER_UNAVAILABLE" });
  });

  it("connects Dropbox with a pasted PKCE code and keeps the refresh token in the protected file only", async () => {
    const context = fixture();
    const started = await context.service.connect(OWNER, "dropbox");
    expect(started.connection).toMatchObject({ provider: "dropbox", method: "paste-code", userCode: null, error: null });
    const authorize = new URL(started.connection!.url);
    expect(authorize.origin + authorize.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: DROPBOX_APP_KEY, response_type: "code", token_access_type: "offline", code_challenge_method: "S256",
    });
    expect(authorize.searchParams.has("redirect_uri")).toBe(false);
    context.providers.state.dropboxChallenge = authorize.searchParams.get("code_challenge")!;

    await expect(context.service.submitCode(OWNER, "dropbox", { connectionId: started.connection!.id, code: "wrong-code-999" }))
      .rejects.toMatchObject({ status: 400, code: "CLOUD_EXPORT_CODE_REJECTED" });
    const connected = await context.service.submitCode(OWNER, "dropbox", { connectionId: started.connection!.id, code: " dropbox-code-123 " });

    expect(connected).toMatchObject({ selected: "dropbox", ready: true, connection: null });
    expect(connected.accounts[0]).toEqual({
      provider: "dropbox", available: true, appSource: "environment", connected: true, accountLabel: "owner@example.test", connectedAt: "2026-10-31T12:00:00.000Z",
    });
    expect(JSON.stringify(connected)).not.toContain("dbx-refresh-1");
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations).toEqual({
      people: {
        [OWNER]: { selected: "dropbox", dropbox: { refreshToken: "dbx-refresh-1", accountLabel: "owner@example.test", connectedAt: "2026-10-31T12:00:00.000Z" } },
      },
    });
  });

  it("rejects a code for a sign-in that is not in progress", async () => {
    const context = fixture();
    await expect(context.service.submitCode(OWNER, "dropbox", { connectionId: "00000000-0000-4000-8000-000000000000", code: "dropbox-code-123" }))
      .rejects.toBeInstanceOf(ExportDestinationError);
    await context.service.connect(OWNER, "dropbox");
    await expect(context.service.submitCode(OWNER, "dropbox", { connectionId: "00000000-0000-4000-8000-000000000000", code: "dropbox-code-123" }))
      .rejects.toMatchObject({ status: 409, code: "CLOUD_EXPORT_CONNECTION_MISSING" });
  });

  it("uploads to the Dropbox app folder and keeps only the newest files", async () => {
    const context = fixture();
    await connectDropbox(context);
    const file = (name: string) => ({ folder: ["data-exports", "schedule-1"], name, content: "Home time,Value\n", retentionCount: 2 });

    for (const name of ["one.csv", "two.csv", "three.csv"]) await expect(context.service.deliver(OWNER, file(name))).resolves.toBe("dropbox");

    expect([...context.providers.dropboxFiles.keys()].sort()).toEqual([
      "/data-exports/schedule-1/three.csv",
      "/data-exports/schedule-1/two.csv",
    ]);
    const upload = context.providers.fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/files/upload"))!;
    expect(header(upload[1], "authorization")).toBe("Bearer dbx-access-1");
    expect(JSON.parse(header(upload[1], "dropbox-api-arg")!)).toMatchObject({ mode: "overwrite", autorename: false });
  });

  it("explains a revoked Dropbox refresh token instead of failing silently", async () => {
    const context = fixture({
      stored: { people: { [OWNER]: { selected: "dropbox", dropbox: { refreshToken: "dbx-revoked", accountLabel: null, connectedAt: "2026-10-01T00:00:00.000Z" } } } },
    });

    await expect(context.service.deliver(OWNER, { folder: ["data-exports", "s"], name: "a.csv", content: "x", retentionCount: 1 }))
      .rejects.toThrowError("Dropbox access was removed. Connect Dropbox again under Scheduled exports.");
  });

  it("connects Google Drive with a device code and finishes in the background", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const context = fixture();
    const onConnected = vi.fn();

    const started = await context.service.connect(OWNER, "google-drive", onConnected);
    expect(started.connection).toMatchObject({
      provider: "google-drive", method: "enter-code", url: "https://www.google.com/device", userCode: "ABCD-EFGH", error: null,
    });
    const deviceRequest = context.providers.fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/device/code"))!;
    expect(new URLSearchParams(String(deviceRequest[1]?.body)).get("scope")).toBe("https://www.googleapis.com/auth/drive.file");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(context.service.status(OWNER).connection?.error).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onConnected).toHaveBeenCalledOnce();
    expect(context.service.status(OWNER)).toMatchObject({ selected: "google-drive", ready: true, connection: null });
    expect(context.service.status(OWNER).accounts[1]).toMatchObject({ connected: true, accountLabel: "owner@gmail.example" });
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations?.people?.[OWNER]?.googleDrive?.refreshToken).toBe("g-refresh-1");
  });

  it("creates Stugu folders in Google Drive once and prunes beyond retention", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const context = fixture();
    context.providers.state.approveAfterPolls = 0;
    await context.service.connect(OWNER, "google-drive");
    await vi.advanceTimersByTimeAsync(5_000);
    const file = (name: string) => ({ folder: ["data-exports", "schedule-1"], name, content: "Home time,Value\n", retentionCount: 1 });

    await context.service.deliver(OWNER, file("first.csv"));
    await context.service.deliver(OWNER, file("second.csv"));

    const folders = context.providers.driveItems.filter((item) => item.folder);
    expect(folders.map(({ name, parent }) => ({ name, parent }))).toEqual([
      { name: "Stugu", parent: "root" },
      { name: "data-exports", parent: folders[0]!.id },
      { name: "schedule-1", parent: folders[1]!.id },
    ]);
    expect(context.providers.driveItems.filter((item) => !item.folder).map((item) => item.name)).toEqual(["second.csv"]);
  });

  it("disconnects, revokes access, and falls back to the NAS", async () => {
    const context = fixture({ nas: true });
    await connectDropbox(context);

    const status = await context.service.disconnect(OWNER, "dropbox");

    expect(status).toMatchObject({ selected: "nas", ready: true });
    expect(status.accounts[0]).toMatchObject({ connected: false });
    expect(context.providers.revoked).toEqual(["Bearer dbx-access-1"]);
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations).toEqual({});
  });

  it("only selects a cloud drive once it is connected", async () => {
    const context = fixture({ nas: true });
    expect(() => context.service.select(OWNER, { selected: "google-drive" })).toThrowError(expect.objectContaining({ status: 409 }) as Error);
    expect(() => context.service.select(OWNER, { selected: "icloud" })).toThrowError(expect.objectContaining({ status: 400 }) as Error);
    await connectDropbox(context);
    expect(context.service.select(OWNER, { selected: "nas" })).toMatchObject({ selected: "nas" });
    expect(context.service.select(OWNER, { selected: "dropbox" })).toMatchObject({ selected: "dropbox" });
  });

  it("keeps each person's drives, choice, and sign-in to themselves", async () => {
    const context = fixture({ nas: true });
    await connectDropbox(context, OWNER);
    const ownerSignIn = await context.service.connect(OWNER, "google-drive");

    const admin = context.service.status(ADMIN);
    expect(admin).toMatchObject({ selected: "nas", ready: true, connection: null });
    expect(admin.accounts.map((account) => [account.connected, account.accountLabel])).toEqual([[false, null], [false, null]]);
    expect(() => context.service.select(ADMIN, { selected: "dropbox" })).toThrowError(expect.objectContaining({ code: "CLOUD_EXPORT_NOT_CONNECTED" }) as Error);
    await expect(context.service.deliver(ADMIN, { folder: ["data-exports", "s"], name: "a.csv", content: "x", retentionCount: 1 }))
      .rejects.toThrowError("NAS exports are handed to the storage worker");
    await context.service.disconnect(ADMIN, "dropbox");
    context.service.cancelConnection(ADMIN);

    expect(context.service.status(OWNER)).toMatchObject({ selected: "dropbox", connection: { id: ownerSignIn.connection!.id } });
    expect(context.service.status(OWNER).accounts[0]).toMatchObject({ connected: true, accountLabel: "owner@example.test" });
    expect(context.providers.revoked).toEqual([]);
    await expect(context.service.submitCode(ADMIN, "dropbox", { connectionId: ownerSignIn.connection!.id, code: "dropbox-code-123" }))
      .rejects.toMatchObject({ code: "CLOUD_EXPORT_CONNECTION_MISSING" });
    context.service.cancelConnection(OWNER);
  });

  it("sends a departed person's exports to the NAS at once and then revokes their drives", async () => {
    const context = fixture({ nas: true });
    await connectDropbox(context, OWNER);
    await connectDropbox(context, ADMIN);
    context.departed.add(ADMIN);

    expect(context.service.selectedFor(ADMIN)).toBe("nas");
    await expect(context.service.deliver(ADMIN, { folder: ["data-exports", "s"], name: "a.csv", content: "x", retentionCount: 1 }))
      .rejects.toThrowError("NAS exports are handed to the storage worker");

    await context.service.forgetDeparted();

    expect(Object.keys(readIntegrationSecrets(context.secretsFile).exportDestinations?.people ?? {})).toEqual([OWNER]);
    expect(context.providers.revoked).toEqual(["Bearer dbx-access-1"]);
    expect(context.service.status(OWNER)).toMatchObject({ selected: "dropbox", ready: true });
    await context.service.forgetDeparted();
    expect(context.providers.revoked).toHaveLength(1);
  });

  it("retires the installation-wide sign-ins from before 0.62.0 and revokes them once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-export-destinations-legacy-"));
    directories.push(directory);
    const legacyFile = join(directory, "integration-secrets.json");
    writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      exportDestinations: {
        selected: "google-drive",
        googleDrive: { refreshToken: "g-refresh-legacy", accountLabel: "someone@gmail.example", connectedAt: "2026-10-31T09:00:00.000Z" },
        apps: { dropbox: { appKey: "ownerappkey1", updatedAt: "2026-10-30T09:00:00.000Z" } },
      },
    }));
    const stored = readIntegrationSecrets(legacyFile).exportDestinations!;
    expect(stored).toEqual({
      apps: { dropbox: { appKey: "ownerappkey1", updatedAt: "2026-10-30T09:00:00.000Z" } },
      retired: { googleDrive: { refreshToken: "g-refresh-legacy", accountLabel: "someone@gmail.example", connectedAt: "2026-10-31T09:00:00.000Z" } },
    });
    const context = fixture({ nas: true, stored });
    expect(context.service.status(OWNER)).toMatchObject({ selected: "nas", ready: true });
    expect(context.service.status(OWNER).accounts[1]).toMatchObject({ connected: false });

    await context.service.forgetDeparted();

    expect(context.providers.revoked).toEqual(["g-refresh-legacy"]);
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations).toEqual({ apps: stored.apps });
  });

  it("lets an Owner/Admin enter the provider apps everyone signs in through", async () => {
    const context = fixture({ nas: true, configured: false });

    context.service.saveApp("dropbox", { appKey: ` ${DROPBOX_APP_KEY} ` });
    const withDropbox = context.service.status(ADMIN);
    expect(withDropbox.accounts[0]).toMatchObject({ available: true, appSource: "protected-file", connected: false });
    expect(withDropbox.accounts[1]).toMatchObject({ available: false, appSource: null });
    context.service.saveApp("google-drive", { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET });
    const withGoogle = context.service.status(OWNER);
    expect(withGoogle.accounts[1]).toMatchObject({ available: true, appSource: "protected-file" });
    expect(JSON.stringify(withGoogle)).not.toContain(GOOGLE_CLIENT_SECRET);
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations).toEqual({
      apps: {
        dropbox: { appKey: DROPBOX_APP_KEY, updatedAt: "2026-10-31T12:00:00.000Z" },
        googleDrive: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, updatedAt: "2026-10-31T12:00:00.000Z" },
      },
    });

    // Both sign-ins run through the entered apps, and the apps survive a restart.
    await expect(connectDropbox(context)).resolves.toMatchObject({ selected: "dropbox", ready: true });
    const google = await context.service.connect(OWNER, "google-drive");
    context.service.cancelConnection(OWNER);
    const deviceRequest = context.providers.fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/device/code"))!;
    expect(new URLSearchParams(String(deviceRequest[1]?.body)).get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(google.connection).toMatchObject({ provider: "google-drive", method: "enter-code" });
    const restarted = fixture({ configured: false, stored: readIntegrationSecrets(context.secretsFile).exportDestinations! });
    expect(restarted.service.status(OWNER).accounts.map((account) => [account.appSource, account.connected]))
      .toEqual([["protected-file", true], ["protected-file", false]]);
  });

  it("prefers an entered app over the built-in one and falls back when it is removed", async () => {
    const context = fixture({ apps: "built-in" });
    expect(context.service.status(OWNER).accounts[0]).toMatchObject({ available: true, appSource: "built-in" });

    context.service.saveApp("dropbox", { appKey: "ownerappkey1" });
    const started = await context.service.connect(ADMIN, "dropbox");
    expect(new URL(started.connection!.url).searchParams.get("client_id")).toBe("ownerappkey1");

    // Changing the shared app ends anyone's sign-in that was running through the old one.
    context.service.removeApp("dropbox");
    const removed = context.service.status(ADMIN);
    expect(removed.connection).toBeNull();
    expect(removed.accounts[0]).toMatchObject({ available: true, appSource: "built-in" });
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations).toEqual({});
    context.service.removeApp("dropbox");
    expect(context.service.status(OWNER).accounts[0]).toMatchObject({ appSource: "built-in" });
  });

  it("refuses malformed apps, environment apps, and apps anyone's connected account still uses", async () => {
    const empty = fixture({ configured: false });
    const invalid = { status: 400, code: "CLOUD_EXPORT_APP_INVALID" };
    expect(() => empty.service.saveApp("dropbox", { appKey: "not a key" })).toThrowError(expect.objectContaining(invalid) as Error);
    expect(() => empty.service.saveApp("dropbox", { appKey: DROPBOX_APP_KEY, clientSecret: "extra-field" }))
      .toThrowError(expect.objectContaining(invalid) as Error);
    expect(() => empty.service.saveApp("google-drive", { clientId: GOOGLE_CLIENT_ID })).toThrowError(expect.objectContaining(invalid) as Error);
    expect(() => empty.service.saveApp("google-drive", { clientId: "1234567890-test", clientSecret: GOOGLE_CLIENT_SECRET }))
      .toThrowError(expect.objectContaining(invalid) as Error);
    expect(() => updateIntegrationSecrets(empty.secretsFile, {
      exportDestinations: { apps: { dropbox: { appKey: "x", updatedAt: "2026-10-31T12:00:00.000Z" } } },
    })).toThrow("the Dropbox app is invalid");
    expect(() => updateIntegrationSecrets(empty.secretsFile, {
      exportDestinations: { people: JSON.parse("{\"__proto__\":{\"selected\":\"nas\"}}") as never },
    })).toThrow("the people are invalid");

    const environment = fixture();
    const owned = { status: 409, code: "CLOUD_EXPORT_APP_ENVIRONMENT_OWNED" };
    expect(() => environment.service.saveApp("dropbox", { appKey: "ownerappkey1" })).toThrowError(expect.objectContaining(owned) as Error);
    expect(() => environment.service.removeApp("google-drive")).toThrowError(expect.objectContaining(owned) as Error);

    const inUse = fixture({ nas: true, configured: false });
    inUse.service.saveApp("dropbox", { appKey: DROPBOX_APP_KEY });
    await connectDropbox(inUse, ADMIN);
    const connected = { status: 409, code: "CLOUD_EXPORT_APP_IN_USE", message: expect.stringContaining("One account is still connected") };
    expect(() => inUse.service.saveApp("dropbox", { appKey: "ownerappkey2" })).toThrowError(expect.objectContaining(connected) as Error);
    expect(() => inUse.service.removeApp("dropbox")).toThrowError(expect.objectContaining(connected) as Error);
    await inUse.service.disconnect(ADMIN, "dropbox");
    expect(inUse.providers.revoked).toEqual(["Bearer dbx-access-1"]);
    inUse.service.removeApp("dropbox");
    expect(inUse.service.status(OWNER).accounts[0]).toMatchObject({ available: false, appSource: null });
  });

  it("keeps connected drives when another integration secret is saved", async () => {
    const context = fixture();
    await connectDropbox(context);
    updateIntegrationSecrets(context.secretsFile, { telegram: { botToken: "123456:telegram-token", chatId: "42" } });
    expect(readIntegrationSecrets(context.secretsFile).exportDestinations?.people?.[OWNER]?.dropbox?.refreshToken).toBe("dbx-refresh-1");
  });

  it("serves each Owner/Admin their own drives and forgets a removed Admin's", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-export-destination-routes-"));
    directories.push(directory);
    const secretsFile = join(directory, "integration-secrets.json");
    const providers = fakeProviders();
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        INTEGRATION_SECRETS_FILE: secretsFile,
        STUGU_DROPBOX_APP_KEY: DROPBOX_APP_KEY,
      }),
      exportDestinationFetcher: providers.fetchImpl,
      startBackground: false,
    });
    const owner = await setupOwner(runtime);
    const joinAs = async (email: string, role: "admin" | "member") => {
      const invitation = await owner.agent.post("/api/v1/tenant/members")
        .set("x-csrf-token", owner.csrf)
        .send({ email, role, grants: [] })
        .expect(201);
      const agent = request.agent(runtime!.app);
      const registered = await agent.post("/api/v1/auth/register")
        .send({ token: invitation.body.registrationToken, password: `${role} password long enough` })
        .expect(201);
      return { agent, csrf: registered.body.csrfToken as string };
    };
    const member = await joinAs("member@example.test", "member");
    const admin = await joinAs("admin@example.test", "admin");
    await member.agent.get("/api/v1/system/export-destinations").expect(403);

    const initial = await owner.agent.get("/api/v1/system/export-destinations").expect(200);
    expect(initial.headers["cache-control"]).toBe("no-store");
    expect(initial.body.accounts.map((account: { provider: string; available: boolean }) => [account.provider, account.available]))
      .toEqual([["dropbox", true], ["google-drive", Boolean(PROJECT_CLOUD_EXPORT_APPS.googleDriveClientId)]]);

    const connect = async (person: { agent: ReturnType<typeof request.agent>; csrf: string }) => {
      const started = await person.agent.post("/api/v1/system/export-destinations/dropbox/connect").set("x-csrf-token", person.csrf).expect(200);
      providers.state.dropboxChallenge = new URL(started.body.connection.url).searchParams.get("code_challenge")!;
      return person.agent.post("/api/v1/system/export-destinations/dropbox/code")
        .set("x-csrf-token", person.csrf)
        .send({ connectionId: started.body.connection.id, code: "dropbox-code-123" })
        .expect(200);
    };
    const connected = await connect(owner);
    expect(connected.body).toMatchObject({ selected: "dropbox", ready: true, connection: null });
    expect(JSON.stringify(connected.body)).not.toContain("dbx-refresh-1");
    expect(readFileSync(secretsFile, "utf8")).toContain("dbx-refresh-1");

    // The Admin sees none of the Owner's drive and cannot disconnect it.
    const adminView = await admin.agent.get("/api/v1/system/export-destinations").expect(200);
    expect(adminView.body).toMatchObject({ selected: "nas", connection: null });
    expect(adminView.body.accounts[0]).toMatchObject({ connected: false, accountLabel: null });
    await admin.agent.delete("/api/v1/system/export-destinations/dropbox").set("x-csrf-token", admin.csrf).expect(200);
    expect((await owner.agent.get("/api/v1/system/export-destinations").expect(200)).body.accounts[0]).toMatchObject({ connected: true });

    await connect(admin);
    expect(Object.keys(readIntegrationSecrets(secretsFile).exportDestinations?.people ?? {})).toHaveLength(2);
    await owner.agent.delete("/api/v1/tenant/members/admin%40example.test").set("x-csrf-token", owner.csrf).expect(204);
    expect(Object.keys(readIntegrationSecrets(secretsFile).exportDestinations?.people ?? {})).toHaveLength(1);
    expect((await owner.agent.get("/api/v1/system/export-destinations").expect(200)).body.accounts[0]).toMatchObject({ connected: true });

    await owner.agent.post("/api/v1/system/export-destinations/icloud/connect").set("x-csrf-token", owner.csrf).expect(404);
    await owner.agent.put("/api/v1/system/export-destinations").set("x-csrf-token", owner.csrf).send({ selected: "nas" }).expect(200);
    const disconnected = await owner.agent.delete("/api/v1/system/export-destinations/dropbox").set("x-csrf-token", owner.csrf).expect(200);
    expect(disconnected.body.accounts[0]).toMatchObject({ connected: false });

    // Set up can add the app the environment leaves out, but never replace the environment's.
    await member.agent.put("/api/v1/system/export-destinations/google-drive/app").set("x-csrf-token", member.csrf)
      .send({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }).expect(403);
    await owner.agent.put("/api/v1/system/export-destinations/dropbox/app").set("x-csrf-token", owner.csrf)
      .send({ appKey: "ownerappkey1" }).expect(409);
    await owner.agent.put("/api/v1/system/export-destinations/google-drive/app").set("x-csrf-token", owner.csrf)
      .send({ clientId: "not-a-client", clientSecret: GOOGLE_CLIENT_SECRET }).expect(400);
    const saved = await owner.agent.put("/api/v1/system/export-destinations/google-drive/app").set("x-csrf-token", owner.csrf)
      .send({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }).expect(200);
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(saved.body.accounts[1]).toMatchObject({ provider: "google-drive", available: true, appSource: "protected-file" });
    expect(JSON.stringify(saved.body)).not.toContain(GOOGLE_CLIENT_SECRET);
    expect(readFileSync(secretsFile, "utf8")).toContain(GOOGLE_CLIENT_SECRET);
    const removed = await owner.agent.delete("/api/v1/system/export-destinations/google-drive/app").set("x-csrf-token", owner.csrf).expect(200);
    expect(removed.body.accounts[1].appSource).toBe(PROJECT_CLOUD_EXPORT_APPS.googleDriveClientId ? "built-in" : null);
    expect(readFileSync(secretsFile, "utf8")).not.toContain(GOOGLE_CLIENT_SECRET);
  });
});
