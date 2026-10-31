import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CLOUD_EXPORT_PROVIDERS,
  EXPORT_DESTINATION_KINDS,
  isOneOf,
  type CloudExportAccount,
  type CloudExportConnection,
  type CloudExportProvider,
  type ExportDestinationKind,
  type ExportDestinationStatus,
} from "@climate-twin/contracts";
import { HttpError } from "../http-error.js";
import { updateIntegrationSecrets } from "../integration-secrets.js";
import type { SystemStorageService } from "../system-storage.js";
import {
  dropboxAccountLabel,
  dropboxAuthorizeUrl,
  exchangeDropboxCode,
  refreshDropboxToken,
  revokeDropboxToken,
  uploadToDropbox,
} from "./dropbox.js";
import {
  googleAccountLabel,
  pollGoogleDeviceSignIn,
  refreshGoogleToken,
  revokeGoogleToken,
  startGoogleDeviceSignIn,
  uploadToGoogleDrive,
  type GoogleDevicePoll,
} from "./google-drive.js";
import { ProviderRequestError, type AccessToken, type CloudExportFile, type OAuthTokens } from "./provider-http.js";
import type { CloudAccountSecret, ExportDestinationSecrets } from "./secrets.js";

const PASTE_CODE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const SLOW_DOWN_STEP_MS = 5_000;

const PROVIDER_NAMES: Record<CloudExportProvider, string> = { dropbox: "Dropbox", "google-drive": "Google Drive" };
const SECRET_KEYS = { dropbox: "dropbox", "google-drive": "googleDrive" } as const satisfies Record<CloudExportProvider, keyof ExportDestinationSecrets>;

export class ExportDestinationError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "ExportDestinationError";
  }
}

export interface ExportDestinationServiceOptions {
  secretsFile: string;
  /** The destinations already in the protected secrets file when the API started. */
  stored: ExportDestinationSecrets | null;
  systemStorage: Pick<SystemStorageService, "status">;
  dropboxAppKey: string | null;
  googleDriveClientId: string | null;
  googleDriveClientSecret: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface PendingConnection {
  connection: CloudExportConnection;
  codeVerifier: string | null;
  deviceCode: string | null;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  onConnected: (() => void) | null;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

/**
 * Owns the installation-wide choice of where scheduled CSV exports go and the cloud sign-ins behind it.
 * The NAS path itself stays with SystemStorageService; this service only reads whether it is connected.
 */
export class ExportDestinationService {
  readonly #options: ExportDestinationServiceOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #accessTokens = new Map<CloudExportProvider, AccessToken>();
  #state: ExportDestinationSecrets;
  #pending: PendingConnection | null = null;

  constructor(options: ExportDestinationServiceOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#state = options.stored ?? { selected: "nas" };
  }

  status(): ExportDestinationStatus {
    this.#markExpired();
    const nasConnected = this.#nasConnected();
    return {
      selected: this.#state.selected,
      ready: this.#ready(nasConnected),
      nasConnected,
      accounts: CLOUD_EXPORT_PROVIDERS.map((provider) => this.#account(provider)),
      connection: this.#pending ? { ...this.#pending.connection } : null,
    };
  }

  selected(): ExportDestinationKind {
    return this.#state.selected;
  }

  ready(): boolean {
    return this.#ready(this.#nasConnected());
  }

  select(body: Record<string, unknown>): ExportDestinationStatus {
    const selected = body.selected;
    if (!isOneOf(selected, EXPORT_DESTINATION_KINDS) || Object.keys(body).some((key) => key !== "selected")) {
      throw new ExportDestinationError(400, "INVALID_EXPORT_DESTINATION", "Choose nas, dropbox, or google-drive");
    }
    if (selected !== "nas" && !this.#secret(selected)) {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_NOT_CONNECTED", `Connect ${PROVIDER_NAMES[selected]} first`);
    }
    this.#persist({ ...this.#state, selected });
    return this.status();
  }

  /** Starts a sign-in; `onConnected` runs once the account is saved, which for Google Drive happens in the background. */
  async connect(provider: CloudExportProvider, onConnected: (() => void) | null = null): Promise<ExportDestinationStatus> {
    if (!this.#available(provider)) {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_PROVIDER_UNAVAILABLE", `${PROVIDER_NAMES[provider]} is not set up on this installation yet`);
    }
    this.cancelConnection();
    const pending = provider === "dropbox" ? this.#pasteCodeConnection() : await this.#deviceConnection();
    pending.onConnected = onConnected;
    this.#pending = pending;
    return this.status();
  }

  /** Finishes a Dropbox sign-in with the code Dropbox showed after the owner chose Allow. */
  async submitCode(provider: CloudExportProvider, body: Record<string, unknown>): Promise<ExportDestinationStatus> {
    const pending = this.#pending;
    this.#markExpired();
    if (provider !== "dropbox" || pending?.connection.provider !== provider || !pending.codeVerifier
      || body.connectionId !== pending.connection.id || pending.connection.error) {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_CONNECTION_MISSING", `Start connecting ${PROVIDER_NAMES[provider]} again`);
    }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (code.length < 8 || code.length > 512 || /\s/u.test(code)) {
      throw new ExportDestinationError(400, "CLOUD_EXPORT_CODE_INVALID", "Paste the code Dropbox shows after you choose Allow");
    }
    const tokens = await this.#exchangeDropboxCode(code, pending.codeVerifier);
    const accountLabel = await dropboxAccountLabel(this.#fetch, tokens.accessToken).catch(() => null);
    this.#completeConnection(pending, tokens, accountLabel);
    return this.status();
  }

  cancelConnection(): void {
    if (this.#pending?.timer) clearTimeout(this.#pending.timer);
    this.#pending = null;
  }

  async disconnect(provider: CloudExportProvider): Promise<ExportDestinationStatus> {
    if (this.#pending?.connection.provider === provider) this.cancelConnection();
    const account = this.#secret(provider);
    if (!account) return this.status();
    const cachedToken = this.#accessTokens.get(provider) ?? null;
    const next: ExportDestinationSecrets = { ...this.#state, selected: this.#state.selected === provider ? "nas" : this.#state.selected };
    delete next[SECRET_KEYS[provider]];
    this.#persist(next);
    this.#accessTokens.delete(provider);
    await this.#revoke(provider, account, cachedToken).catch(() => undefined);
    return this.status();
  }

  /** Uploads one export to the selected cloud drive and returns which one received it. */
  async deliver(file: CloudExportFile): Promise<CloudExportProvider> {
    const provider = this.#state.selected;
    if (provider === "nas") throw new Error("NAS exports are handed to the storage worker");
    try {
      await this.#upload(provider, file);
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 401) throw error;
      this.#accessTokens.delete(provider);
      await this.#upload(provider, file);
    }
    return provider;
  }

  stop(): void {
    this.cancelConnection();
  }

  #nasConnected(): boolean {
    return this.#options.systemStorage.status().settings.backups.kind === "nas-path";
  }

  #ready(nasConnected: boolean): boolean {
    const selected = this.#state.selected;
    return selected === "nas" ? nasConnected : Boolean(this.#secret(selected)) && this.#available(selected);
  }

  #available(provider: CloudExportProvider): boolean {
    return provider === "dropbox"
      ? Boolean(this.#options.dropboxAppKey)
      : Boolean(this.#options.googleDriveClientId && this.#options.googleDriveClientSecret);
  }

  #secret(provider: CloudExportProvider): CloudAccountSecret | null {
    return this.#state[SECRET_KEYS[provider]] ?? null;
  }

  #account(provider: CloudExportProvider): CloudExportAccount {
    const secret = this.#secret(provider);
    return {
      provider,
      available: this.#available(provider),
      connected: secret !== null,
      accountLabel: secret?.accountLabel ?? null,
      connectedAt: secret?.connectedAt ?? null,
    };
  }

  #persist(next: ExportDestinationSecrets): void {
    updateIntegrationSecrets(this.#options.secretsFile, { exportDestinations: next });
    this.#state = next;
  }

  #markExpired(): void {
    const connection = this.#pending?.connection;
    if (connection && !connection.error && Date.parse(connection.expiresAt) <= this.#now().getTime()) {
      connection.error = `The ${PROVIDER_NAMES[connection.provider]} sign-in expired. Start again.`;
      if (this.#pending?.timer) clearTimeout(this.#pending.timer);
    }
  }

  #pasteCodeConnection(): PendingConnection {
    const codeVerifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    return {
      connection: {
        id: randomUUID(),
        provider: "dropbox",
        method: "paste-code",
        url: dropboxAuthorizeUrl(this.#options.dropboxAppKey!, challenge),
        userCode: null,
        expiresAt: new Date(this.#now().getTime() + PASTE_CODE_TTL_MS).toISOString(),
        error: null,
      },
      codeVerifier,
      deviceCode: null,
      intervalMs: 0,
      timer: null,
      onConnected: null,
    };
  }

  async #deviceConnection(): Promise<PendingConnection> {
    let signIn;
    try {
      signIn = await startGoogleDeviceSignIn(this.#fetch, { clientId: this.#options.googleDriveClientId!, now: this.#now().getTime() });
    } catch (error) {
      throw new ExportDestinationError(502, "CLOUD_EXPORT_PROVIDER_FAILED", error instanceof Error ? error.message : "Google Drive could not start the sign-in");
    }
    const pending: PendingConnection = {
      connection: {
        id: randomUUID(),
        provider: "google-drive",
        method: "enter-code",
        url: signIn.verificationUrl,
        userCode: signIn.userCode,
        expiresAt: new Date(signIn.expiresAt).toISOString(),
        error: null,
      },
      codeVerifier: null,
      deviceCode: signIn.deviceCode,
      intervalMs: signIn.intervalMs,
      timer: null,
      onConnected: null,
    };
    this.#schedulePoll(pending);
    return pending;
  }

  #schedulePoll(pending: PendingConnection): void {
    pending.timer = setTimeout(() => void this.#pollDeviceSignIn(pending), pending.intervalMs);
    pending.timer.unref?.();
  }

  async #pollDeviceSignIn(pending: PendingConnection): Promise<void> {
    pending.timer = null;
    this.#markExpired();
    if (this.#pending !== pending || pending.connection.error) return;
    let result: GoogleDevicePoll | null = null;
    try {
      result = await pollGoogleDeviceSignIn(this.#fetch, {
        clientId: this.#options.googleDriveClientId!,
        clientSecret: this.#options.googleDriveClientSecret!,
        deviceCode: pending.deviceCode!,
        now: this.#now().getTime(),
      });
    } catch {
      // A transient network or provider failure; keep polling until the code expires.
    }
    if (this.#pending !== pending) return;
    await this.#applyDevicePoll(pending, result);
  }

  async #applyDevicePoll(pending: PendingConnection, result: GoogleDevicePoll | null): Promise<void> {
    if (result?.state === "approved") {
      const accountLabel = await googleAccountLabel(this.#fetch, result.tokens.accessToken).catch(() => null);
      if (this.#pending !== pending) return;
      try {
        this.#completeConnection(pending, result.tokens, accountLabel);
      } catch (error) {
        pending.connection.error = error instanceof Error ? error.message.slice(0, 500) : "Google Drive could not be saved";
      }
      return;
    }
    if (result?.state === "denied" || result?.state === "expired") {
      pending.connection.error = result.state === "denied"
        ? "Google sign-in was declined. Start again to retry."
        : "The Google Drive sign-in expired. Start again.";
      return;
    }
    if (result?.state === "slow-down") pending.intervalMs += SLOW_DOWN_STEP_MS;
    this.#schedulePoll(pending);
  }

  async #exchangeDropboxCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
    try {
      return await exchangeDropboxCode(this.#fetch, { appKey: this.#options.dropboxAppKey!, code, codeVerifier, now: this.#now().getTime() });
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 400) {
        throw new ExportDestinationError(400, "CLOUD_EXPORT_CODE_REJECTED", "Dropbox did not accept that code. Paste the newest code, or start again.");
      }
      throw new ExportDestinationError(502, "CLOUD_EXPORT_PROVIDER_FAILED", error instanceof Error ? error.message : "Dropbox could not be reached");
    }
  }

  /** Saves the account from `pending`; a sign-in started meanwhile for another drive is left running. */
  #completeConnection(pending: PendingConnection, tokens: OAuthTokens, accountLabel: string | null): void {
    const provider = pending.connection.provider;
    const account: CloudAccountSecret = {
      refreshToken: tokens.refreshToken,
      accountLabel: accountLabel?.slice(0, 320) ?? null,
      connectedAt: this.#now().toISOString(),
    };
    this.#persist({ ...this.#state, [SECRET_KEYS[provider]]: account, selected: provider });
    this.#accessTokens.set(provider, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
    if (this.#pending === pending) this.cancelConnection();
    try {
      pending.onConnected?.();
    } catch {
      // A failed audit write never undoes an account that is already saved.
    }
  }

  async #accessToken(provider: CloudExportProvider): Promise<string> {
    const cached = this.#accessTokens.get(provider);
    const now = this.#now().getTime();
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.accessToken;
    const account = this.#secret(provider);
    if (!account || !this.#available(provider)) throw new Error(`Connect ${PROVIDER_NAMES[provider]} in Set up first`);
    let token: AccessToken;
    try {
      token = provider === "dropbox"
        ? await refreshDropboxToken(this.#fetch, { appKey: this.#options.dropboxAppKey!, refreshToken: account.refreshToken, now })
        : await refreshGoogleToken(this.#fetch, {
          clientId: this.#options.googleDriveClientId!,
          clientSecret: this.#options.googleDriveClientSecret!,
          refreshToken: account.refreshToken,
          now,
        });
    } catch (error) {
      if (error instanceof ProviderRequestError && error.providerCode === "invalid_grant") {
        throw new Error(`${PROVIDER_NAMES[provider]} access was removed. Connect ${PROVIDER_NAMES[provider]} again in Set up.`);
      }
      throw error;
    }
    this.#accessTokens.set(provider, token);
    return token.accessToken;
  }

  async #upload(provider: CloudExportProvider, file: CloudExportFile): Promise<void> {
    const accessToken = await this.#accessToken(provider);
    if (provider === "dropbox") await uploadToDropbox(this.#fetch, accessToken, file);
    else await uploadToGoogleDrive(this.#fetch, accessToken, file);
  }

  async #revoke(provider: CloudExportProvider, account: CloudAccountSecret, cached: AccessToken | null): Promise<void> {
    if (!this.#available(provider)) return;
    if (provider === "google-drive") {
      await revokeGoogleToken(this.#fetch, account.refreshToken);
      return;
    }
    const accessToken = cached?.accessToken ?? (await refreshDropboxToken(this.#fetch, {
      appKey: this.#options.dropboxAppKey!,
      refreshToken: account.refreshToken,
      now: this.#now().getTime(),
    })).accessToken;
    await revokeDropboxToken(this.#fetch, accessToken);
  }
}
