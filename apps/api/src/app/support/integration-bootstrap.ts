import { existsSync } from "node:fs";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "../../config.js";
import { ClimateDatabase } from "../../db.js";
import { readIntegrationSecrets, updateIntegrationSecrets, type IntegrationSecrets } from "../../integration-secrets.js";
import { IntegrationMetadataStore } from "../../integration-metadata.js";

export function sameHomeAssistantCredential(
  left: IntegrationSecrets["homeAssistant"],
  right: { url: string | null; token: string | null },
): boolean {
  return Boolean(left && left.url === right.url && left.token === right.token);
}

export function sameTpLinkCredential(
  left: IntegrationSecrets["tpLink"],
  right: { host: string | null; username: string | null; password: string | null },
): boolean {
  return Boolean(left && left.host === right.host && left.username === right.username && left.password === right.password);
}

export function sameTelegramCredential(
  left: IntegrationSecrets["telegram"],
  right: { botToken: string | null; chatId: string | null },
): boolean {
  return Boolean(left && left.botToken === right.botToken && left.chatId === right.chatId);
}

export function mirrorEnvironmentWebhook(config: AppConfig): void {
  const webhookDestinations = configuredAlertWebhookDestinations(config);
  if (config.alertWebhookSource !== "environment" || webhookDestinations.length === 0) return;
  try {
    const fileExists = existsSync(config.integrationSecretsFile);
    const secrets = fileExists ? readIntegrationSecrets(config.integrationSecretsFile) : null;
    const existing = secrets?.webhookDestinations
      ?? (secrets?.webhook ? [{ id: "primary", ...secrets.webhook }] : []);
    if (JSON.stringify(existing) === JSON.stringify(webhookDestinations)) return;
    updateIntegrationSecrets(config.integrationSecretsFile, {
      webhook: null,
      webhookDestinations,
      ...(!fileExists ? { metadataSnapshotIncomplete: true } : {}),
    });
  } catch {
    // Environment configuration remains usable. A missing/unreadable protected
    // store must never trigger metadata pruning or reveal credential details.
  }
}

type CopiedListKey = "homeAssistantConnections" | "tpLinkConnections" | "appleNotesGrants" | "webhookDestinations";
type CopiedLists = Partial<Pick<IntegrationSecrets, CopiedListKey>>;
const COPIED_LIST_KEYS: readonly CopiedListKey[] = ["homeAssistantConnections", "tpLinkConnections", "appleNotesGrants", "webhookDestinations"];

/** Shallow copies of each present credential list, so reconciling metadata cannot mutate its source. */
function copiedLists(source: { [K in CopiedListKey]?: IntegrationSecrets[K] | undefined }): CopiedLists {
  return Object.fromEntries(COPIED_LIST_KEYS.flatMap((key) => {
    const list = source[key];
    return list ? [[key, list.map((item) => ({ ...item }))]] : [];
  }));
}

/** The protected secrets file, and whether it is a complete snapshot that may prune metadata. */
function readProtectedSecrets(config: AppConfig, existedAtStart: boolean): { secrets: IntegrationSecrets | null; authoritative: boolean } {
  if (!existsSync(config.integrationSecretsFile)) return { secrets: null, authoritative: false };
  try {
    const secrets = readIntegrationSecrets(config.integrationSecretsFile);
    return { secrets, authoritative: existedAtStart && secrets.metadataSnapshotIncomplete !== true };
  } catch {
    // Fail closed: keep last-known metadata active until a validated snapshot
    // can prove that its credential reference was intentionally removed.
    return { secrets: null, authoritative: false };
  }
}

/** Which credentials the deployment environment supplies instead of the protected file. */
function environmentCredentialSources(config: AppConfig, protectedSecrets: IntegrationSecrets | null, firstHouseId: string | null) {
  return {
    homeAssistant: Boolean(
      firstHouseId && !config.homeAssistantLegacyDisabled && config.haUrl && config.haToken
        && !sameHomeAssistantCredential(protectedSecrets?.homeAssistant, { url: config.haUrl, token: config.haToken }),
    ),
    tpLink: Boolean(
      firstHouseId && !config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
        && !sameTpLinkCredential(protectedSecrets?.tpLink, {
          host: config.tpLinkHost, username: config.tpLinkUsername, password: config.tpLinkPassword,
        }),
    ),
    telegram: Boolean(
      config.telegramBotToken && config.telegramChatId
        && !sameTelegramCredential(protectedSecrets?.telegram, {
          botToken: config.telegramBotToken, chatId: config.telegramChatId,
        }),
    ),
    webhook: config.alertWebhookSource === "environment" && configuredAlertWebhookDestinations(config).length > 0,
  };
}

export function initializeIntegrationMetadata(config: AppConfig, database: ClimateDatabase): IntegrationMetadataStore {
  const store = new IntegrationMetadataStore(database);
  const protectedFileExistedAtStart = existsSync(config.integrationSecretsFile);
  mirrorEnvironmentWebhook(config);
  const { secrets: protectedSecrets, authoritative } = readProtectedSecrets(config, protectedFileExistedAtStart);
  const metadataSecrets: IntegrationSecrets = protectedSecrets
    ? { ...protectedSecrets, ...copiedLists(protectedSecrets) }
    : {
        version: 1,
        ...copiedLists({
          homeAssistantConnections: config.homeAssistantConnections,
          tpLinkConnections: config.tpLinkConnections,
          ...(config.appleNotesGrants.length ? { appleNotesGrants: config.appleNotesGrants } : {}),
        }),
      };
  const firstHouseId = database.listHouses().find(hasLocalHouseAuthority)?.id ?? null;
  const fromEnvironment = environmentCredentialSources(config, protectedSecrets, firstHouseId);
  if (fromEnvironment.homeAssistant) delete metadataSecrets.homeAssistant;
  if (fromEnvironment.tpLink) delete metadataSecrets.tpLink;
  if (fromEnvironment.telegram) delete metadataSecrets.telegram;
  if (fromEnvironment.webhook) {
    delete metadataSecrets.webhook;
    delete metadataSecrets.webhookDestinations;
  }
  store.reconcileEnvironment({
    homeAssistant: fromEnvironment.homeAssistant && firstHouseId && config.haUrl
      ? { houseId: firstHouseId, url: config.haUrl }
      : null,
    tpLink: fromEnvironment.tpLink && firstHouseId && config.tpLinkHost
      ? { houseId: firstHouseId, host: config.tpLinkHost }
      : null,
    telegramConfigured: fromEnvironment.telegram,
    webhookDestinationIds: fromEnvironment.webhook
      ? configuredAlertWebhookDestinations(config).map((destination) => destination.id)
      : [],
  });
  store.reconcileProtectedFile({ authoritative, secrets: metadataSecrets, legacyHouseId: firstHouseId });
  return store;
}
