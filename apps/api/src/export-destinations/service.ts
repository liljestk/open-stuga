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
import type { CloudExportApps } from "../config/cloud-export-apps.js";
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
import { resolveCloudExportApps, withAppFromInput, type GoogleDriveApp, type ResolvedCloudExportApps } from "./apps.js";
import { ProviderRequestError, type AccessToken, type CloudExportFile, type OAuthTokens } from "./provider-http.js";
import type { CloudAccountSecret, CloudAccountSecrets, ExportDestinationSecrets, PersonalExportDestination } from "./secrets.js";

const PASTE_CODE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const SLOW_DOWN_STEP_MS = 5_000;

const PROVIDER_NAMES: Record<CloudExportProvider, string> = { dropbox: "Dropbox", "google-drive": "Google Drive" };
const SECRET_KEYS = { dropbox: "dropbox", "google-drive": "googleDrive" } as const satisfies Record<CloudExportProvider, keyof CloudAccountSecrets>;
const APP_INVALID: Record<CloudExportProvider, string> = {
  dropbox: "Paste the app key from the Settings tab of your Dropbox app",
  "google-drive": "Paste the client ID (it ends in .apps.googleusercontent.com) and the client secret of your Google OAuth client",
};

export class ExportDestinationError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "ExportDestinationError";
  }
}

/** The provider apps from the deployment's environment or the built-in apps; an Owner or Admin can add their own. */
export interface ExportDestinationServiceOptions extends CloudExportApps {
  secretsFile: string;
  /** The destinations already in the protected secrets file when the API started. */
  stored: ExportDestinationSecrets | null;
  systemStorage: Pick<SystemStorageService, "status">;
  /** Whether a local account may keep cloud drives: a current Owner or Admin. Anyone else exports to the NAS. */
  mayHoldAccounts: (userId: string) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface PendingConnection {
  userId: string;
  connection: CloudExportConnection;
  codeVerifier: string | null;
  deviceCode: string | null;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  onConnected: (() => void) | null;
}

interface Revocation {
  provider: CloudExportProvider;
  account: CloudAccountSecret;
  cached: AccessToken | null;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function tokenKey(userId: string, provider: CloudExportProvider): string {
  return `${userId}\u0000${provider}`;
}

function withoutAccount(person: PersonalExportDestination, provider: CloudExportProvider): PersonalExportDestination {
  const { [SECRET_KEYS[provider]]: _removed, ...rest } = person;
  return { ...rest, selected: person.selected === provider ? "nas" : person.selected };
}

/** A person who sends exports to the NAS and has no drive needs no entry. */
function worthKeeping(person: PersonalExportDestination): boolean {
  return person.selected !== "nas" || Boolean(person.dropbox || person.googleDrive);
}

function accountsOf(accounts: CloudAccountSecrets): Array<[CloudExportProvider, CloudAccountSecret]> {
  return CLOUD_EXPORT_PROVIDERS.flatMap((provider) => {
    const account = accounts[SECRET_KEYS[provider]];
    return account ? [[provider, account] as [CloudExportProvider, CloudAccountSecret]] : [];
  });
}

/**
 * Owns each person's choice of where their scheduled CSV exports go and the cloud drives they signed in to.
 * A drive belongs to the person who connected it: nobody else sees it, uses it, or disconnects it. The provider
 * apps those sign-ins run through are shared by the installation. The NAS path itself stays with
 * SystemStorageService; this service only reads whether it is connected.
 */
export class ExportDestinationService {
  readonly #options: ExportDestinationServiceOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #accessTokens = new Map<string, AccessToken>();
  /** At most one sign-in per person. */
  readonly #pending = new Map<string, PendingConnection>();
  #state: ExportDestinationSecrets;

  constructor(options: ExportDestinationServiceOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#state = options.stored ?? {};
  }

  /** The signed-in person's destination, drives, and sign-in in progress. */
  status(userId: string): ExportDestinationStatus {
    this.#markExpired(userId);
    const nasConnected = this.#nasConnected();
    const pending = this.#pending.get(userId);
    return {
      selected: this.selectedFor(userId),
      ready: this.#ready(userId, nasConnected),
      nasConnected,
      accounts: CLOUD_EXPORT_PROVIDERS.map((provider) => this.#account(userId, provider)),
      connection: pending ? { ...pending.connection } : null,
    };
  }

  /** Where this person's scheduled exports go: the NAS for nobody, for a person who left, or by choice. */
  selectedFor(userId: string | null): ExportDestinationKind {
    if (!userId || !this.#options.mayHoldAccounts(userId)) return "nas";
    return this.#person(userId)?.selected ?? "nas";
  }

  readyFor(userId: string | null): boolean {
    return this.#ready(userId, this.#nasConnected());
  }

  select(userId: string, body: Record<string, unknown>): ExportDestinationStatus {
    const selected = body.selected;
    if (!isOneOf(selected, EXPORT_DESTINATION_KINDS) || Object.keys(body).some((key) => key !== "selected")) {
      throw new ExportDestinationError(400, "INVALID_EXPORT_DESTINATION", "Choose nas, dropbox, or google-drive");
    }
    if (selected !== "nas" && !this.#secret(userId, selected)) {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_NOT_CONNECTED", `Connect ${PROVIDER_NAMES[selected]} first`);
    }
    this.#updatePerson(userId, (person) => ({ ...person, selected }));
    return this.status(userId);
  }

  /** Starts a sign-in; `onConnected` runs once the account is saved, which for Google Drive happens in the background. */
  async connect(userId: string, provider: CloudExportProvider, onConnected: (() => void) | null = null): Promise<ExportDestinationStatus> {
    if (!this.#available(provider)) {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_PROVIDER_UNAVAILABLE", `${PROVIDER_NAMES[provider]} is not set up on this installation yet`);
    }
    this.cancelConnection(userId);
    const pending = provider === "dropbox" ? this.#pasteCodeConnection(userId) : await this.#deviceConnection(userId);
    pending.onConnected = onConnected;
    this.#pending.set(userId, pending);
    return this.status(userId);
  }

  /** Finishes a Dropbox sign-in with the code Dropbox showed after the person chose Allow. */
  async submitCode(userId: string, provider: CloudExportProvider, body: Record<string, unknown>): Promise<ExportDestinationStatus> {
    const pending = this.#pending.get(userId);
    this.#markExpired(userId);
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
    return this.status(userId);
  }

  cancelConnection(userId: string): void {
    const pending = this.#pending.get(userId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.#pending.delete(userId);
  }

  /**
   * Saves the Dropbox app or Google client an Owner/Admin registered, so the provider works without deployment
   * variables. It replaces a built-in app but never an environment one, and never the app a connected account uses.
   */
  saveApp(provider: CloudExportProvider, body: Record<string, unknown>): void {
    this.#assertAppEditable(provider);
    const apps = withAppFromInput(this.#state.apps, provider, { body, updatedAt: this.#now().toISOString() });
    if (!apps) throw new ExportDestinationError(400, "CLOUD_EXPORT_APP_INVALID", APP_INVALID[provider]);
    this.#cancelConnectionsFor(provider);
    this.#persist({ ...this.#state, apps });
  }

  /** Forgets the app entered in Stugu; the provider falls back to the built-in app, if there is one. */
  removeApp(provider: CloudExportProvider): void {
    this.#assertAppEditable(provider);
    const key = SECRET_KEYS[provider];
    if (!this.#state.apps?.[key]) return;
    this.#cancelConnectionsFor(provider);
    const { [key]: _removed, ...apps } = this.#state.apps;
    const { apps: _previous, ...next } = this.#state;
    this.#persist(Object.keys(apps).length > 0 ? { ...next, apps } : next);
  }

  async disconnect(userId: string, provider: CloudExportProvider): Promise<ExportDestinationStatus> {
    if (this.#pending.get(userId)?.connection.provider === provider) this.cancelConnection(userId);
    const account = this.#secret(userId, provider);
    if (!account) return this.status(userId);
    const cached = this.#accessTokens.get(tokenKey(userId, provider)) ?? null;
    this.#updatePerson(userId, (person) => withoutAccount(person, provider));
    this.#accessTokens.delete(tokenKey(userId, provider));
    await this.#revoke({ provider, account, cached }).catch(() => undefined);
    return this.status(userId);
  }

  /** Uploads one export to the cloud drive this person chose and returns which one received it. */
  async deliver(userId: string | null, file: CloudExportFile): Promise<CloudExportProvider> {
    const provider = this.selectedFor(userId);
    if (provider === "nas" || userId === null) throw new Error("NAS exports are handed to the storage worker");
    try {
      await this.#upload(userId, provider, file);
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 401) throw error;
      this.#accessTokens.delete(tokenKey(userId, provider));
      await this.#upload(userId, provider, file);
    }
    return provider;
  }

  /**
   * Forgets the drives of everyone who is no longer an Owner or Admin, and the unowned sign-ins from before
   * 0.62.0, then revokes them where the provider allows. The file is rewritten before the first revocation.
   */
  async forgetDeparted(): Promise<void> {
    const people = this.#state.people ?? {};
    const departed = Object.keys(people).filter((userId) => !this.#options.mayHoldAccounts(userId));
    const revocations: Revocation[] = accountsOf(this.#state.retired ?? {}).map(([provider, account]) => ({ provider, account, cached: null }));
    for (const userId of departed) {
      this.cancelConnection(userId);
      for (const [provider, account] of accountsOf(people[userId]!)) {
        revocations.push({ provider, account, cached: this.#accessTokens.get(tokenKey(userId, provider)) ?? null });
        this.#accessTokens.delete(tokenKey(userId, provider));
      }
    }
    if (departed.length === 0 && !this.#state.retired) return;
    const { retired: _retired, ...next } = this.#state;
    this.#persist(this.#withPeople(next, Object.fromEntries(Object.entries(people).filter(([userId]) => !departed.includes(userId)))));
    await Promise.allSettled(revocations.map((revocation) => this.#revoke(revocation)));
  }

  start(): void {
    void this.forgetDeparted().catch(() => undefined);
  }

  stop(): void {
    for (const userId of [...this.#pending.keys()]) this.cancelConnection(userId);
  }

  #nasConnected(): boolean {
    return this.#options.systemStorage.status().settings.backups.kind === "nas-path";
  }

  #ready(userId: string | null, nasConnected: boolean): boolean {
    const selected = this.selectedFor(userId);
    return selected === "nas" ? nasConnected : Boolean(this.#secret(userId!, selected)) && this.#available(selected);
  }

  #apps(): ResolvedCloudExportApps {
    return resolveCloudExportApps(this.#options, this.#state.apps);
  }

  #available(provider: CloudExportProvider): boolean {
    return this.#apps()[provider] !== null;
  }

  #dropboxAppKey(): string {
    return this.#apps().dropbox!.appKey;
  }

  #googleClient(): GoogleDriveApp {
    return this.#apps()["google-drive"]!;
  }

  #assertAppEditable(provider: CloudExportProvider): void {
    if (this.#apps()[provider]?.source === "environment") {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_APP_ENVIRONMENT_OWNED", `This installation's environment variables set the ${PROVIDER_NAMES[provider]} app`);
    }
    const connected = Object.values(this.#state.people ?? {}).filter((person) => person[SECRET_KEYS[provider]]).length;
    if (connected > 0) {
      throw new ExportDestinationError(409, "CLOUD_EXPORT_APP_IN_USE",
        `${connected === 1 ? "One account is" : `${connected} accounts are`} still connected to ${PROVIDER_NAMES[provider]} through this app; each must be disconnected before the app can change`);
    }
  }

  #cancelConnectionsFor(provider: CloudExportProvider): void {
    for (const [userId, pending] of [...this.#pending]) {
      if (pending.connection.provider === provider) this.cancelConnection(userId);
    }
  }

  #person(userId: string): PersonalExportDestination | null {
    const people = this.#state.people;
    return people && Object.hasOwn(people, userId) ? people[userId]! : null;
  }

  #secret(userId: string, provider: CloudExportProvider): CloudAccountSecret | null {
    return this.#person(userId)?.[SECRET_KEYS[provider]] ?? null;
  }

  #account(userId: string, provider: CloudExportProvider): CloudExportAccount {
    const secret = this.#secret(userId, provider);
    const app = this.#apps()[provider];
    return {
      provider,
      available: app !== null,
      appSource: app?.source ?? null,
      connected: secret !== null,
      accountLabel: secret?.accountLabel ?? null,
      connectedAt: secret?.connectedAt ?? null,
    };
  }

  #withPeople(state: ExportDestinationSecrets, people: Record<string, PersonalExportDestination>): ExportDestinationSecrets {
    const { people: _previous, ...rest } = state;
    return Object.keys(people).length > 0 ? { ...rest, people } : rest;
  }

  #updatePerson(userId: string, change: (person: PersonalExportDestination) => PersonalExportDestination): void {
    const next = change(this.#person(userId) ?? { selected: "nas" });
    const { [userId]: _previous, ...others } = this.#state.people ?? {};
    this.#persist(this.#withPeople(this.#state, worthKeeping(next) ? { ...others, [userId]: next } : others));
  }

  #persist(next: ExportDestinationSecrets): void {
    updateIntegrationSecrets(this.#options.secretsFile, { exportDestinations: next });
    this.#state = next;
  }

  #markExpired(userId: string): void {
    const pending = this.#pending.get(userId);
    const connection = pending?.connection;
    if (connection && !connection.error && Date.parse(connection.expiresAt) <= this.#now().getTime()) {
      connection.error = `The ${PROVIDER_NAMES[connection.provider]} sign-in expired. Start again.`;
      if (pending.timer) clearTimeout(pending.timer);
    }
  }

  #pasteCodeConnection(userId: string): PendingConnection {
    const codeVerifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    return {
      userId,
      connection: {
        id: randomUUID(),
        provider: "dropbox",
        method: "paste-code",
        url: dropboxAuthorizeUrl(this.#dropboxAppKey(), challenge),
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

  async #deviceConnection(userId: string): Promise<PendingConnection> {
    let signIn;
    try {
      signIn = await startGoogleDeviceSignIn(this.#fetch, { clientId: this.#googleClient().clientId, now: this.#now().getTime() });
    } catch (error) {
      throw new ExportDestinationError(502, "CLOUD_EXPORT_PROVIDER_FAILED", error instanceof Error ? error.message : "Google Drive could not start the sign-in");
    }
    const pending: PendingConnection = {
      userId,
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

  #current(pending: PendingConnection): boolean {
    return this.#pending.get(pending.userId) === pending;
  }

  async #pollDeviceSignIn(pending: PendingConnection): Promise<void> {
    pending.timer = null;
    this.#markExpired(pending.userId);
    if (!this.#current(pending) || pending.connection.error) return;
    let result: GoogleDevicePoll | null = null;
    try {
      result = await pollGoogleDeviceSignIn(this.#fetch, {
        clientId: this.#googleClient().clientId,
        clientSecret: this.#googleClient().clientSecret,
        deviceCode: pending.deviceCode!,
        now: this.#now().getTime(),
      });
    } catch {
      // A transient network or provider failure; keep polling until the code expires.
    }
    if (!this.#current(pending)) return;
    await this.#applyDevicePoll(pending, result);
  }

  async #applyDevicePoll(pending: PendingConnection, result: GoogleDevicePoll | null): Promise<void> {
    if (result?.state === "approved") {
      const accountLabel = await googleAccountLabel(this.#fetch, result.tokens.accessToken).catch(() => null);
      if (!this.#current(pending)) return;
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
      return await exchangeDropboxCode(this.#fetch, { appKey: this.#dropboxAppKey(), code, codeVerifier, now: this.#now().getTime() });
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 400) {
        throw new ExportDestinationError(400, "CLOUD_EXPORT_CODE_REJECTED", "Dropbox did not accept that code. Paste the newest code, or start again.");
      }
      throw new ExportDestinationError(502, "CLOUD_EXPORT_PROVIDER_FAILED", error instanceof Error ? error.message : "Dropbox could not be reached");
    }
  }

  /** Saves the account from `pending` for the person who started it, unless they left while signing in. */
  #completeConnection(pending: PendingConnection, tokens: OAuthTokens, accountLabel: string | null): void {
    const { userId, connection: { provider } } = pending;
    if (!this.#options.mayHoldAccounts(userId)) {
      throw new ExportDestinationError(403, "CLOUD_EXPORT_ACCOUNT_NOT_ALLOWED", "Only an Owner or Admin can connect a cloud drive for exports");
    }
    const account: CloudAccountSecret = {
      refreshToken: tokens.refreshToken,
      accountLabel: accountLabel?.slice(0, 320) ?? null,
      connectedAt: this.#now().toISOString(),
    };
    this.#updatePerson(userId, (person) => ({ ...person, [SECRET_KEYS[provider]]: account, selected: provider }));
    this.#accessTokens.set(tokenKey(userId, provider), { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
    if (this.#current(pending)) this.cancelConnection(userId);
    try {
      pending.onConnected?.();
    } catch {
      // A failed audit write never undoes an account that is already saved.
    }
  }

  async #accessToken(userId: string, provider: CloudExportProvider): Promise<string> {
    const cached = this.#accessTokens.get(tokenKey(userId, provider));
    const now = this.#now().getTime();
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.accessToken;
    const account = this.#secret(userId, provider);
    const name = PROVIDER_NAMES[provider];
    if (!account || !this.#available(provider)) throw new Error(`Connect ${name} under Scheduled exports first`);
    let token: AccessToken;
    try {
      token = await this.#refresh(provider, account.refreshToken);
    } catch (error) {
      if (error instanceof ProviderRequestError && error.providerCode === "invalid_grant") {
        throw new Error(`${name} access was removed. Connect ${name} again under Scheduled exports.`);
      }
      throw error;
    }
    this.#accessTokens.set(tokenKey(userId, provider), token);
    return token.accessToken;
  }

  #refresh(provider: CloudExportProvider, refreshToken: string): Promise<AccessToken> {
    const now = this.#now().getTime();
    if (provider === "dropbox") return refreshDropboxToken(this.#fetch, { appKey: this.#dropboxAppKey(), refreshToken, now });
    const client = this.#googleClient();
    return refreshGoogleToken(this.#fetch, { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken, now });
  }

  async #upload(userId: string, provider: CloudExportProvider, file: CloudExportFile): Promise<void> {
    const accessToken = await this.#accessToken(userId, provider);
    if (provider === "dropbox") await uploadToDropbox(this.#fetch, accessToken, file);
    else await uploadToGoogleDrive(this.#fetch, accessToken, file);
  }

  async #revoke({ provider, account, cached }: Revocation): Promise<void> {
    if (!this.#available(provider)) return;
    if (provider === "google-drive") {
      await revokeGoogleToken(this.#fetch, account.refreshToken);
      return;
    }
    const accessToken = cached?.accessToken ?? (await this.#refresh("dropbox", account.refreshToken)).accessToken;
    await revokeDropboxToken(this.#fetch, accessToken);
  }
}
