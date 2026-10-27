import { updateIntegrationSecrets } from "../integration-secrets.js";
import { HttpError, bodyObject, credentialString, requestPrincipal, requireWorkspaceAdmin } from "./support/index.js";
import { TelegramServiceError } from "../telegram.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Telegram bot discovery, configuration and test messages. */
export function registerTelegramRoutes(context: ApiRouteRegistrationContext): void {
  const config = context.config;
  context.app.post(`${context.prefix}/integrations/telegram/discover`, requireWorkspaceAdmin, async (request, response) => {
      const body = bodyObject(request.body);
      response.json(await context.telegram.discover(credentialString(body, "botToken", 256, true)));
    });
  context.app.put(`${context.prefix}/integrations/telegram/config`, requireWorkspaceAdmin, async (request, response) => {
      const generation = ++context.runtimeState.telegramConfigurationGeneration;
      const body = bodyObject(request.body);
      const botToken = credentialString(body, "botToken", 256, true);
      const chatId = credentialString(body, "chatId", 32, true);
      const rotatingCredentials = Boolean(config.telegramBotToken && config.telegramChatId);
      const identity = await context.telegram.verify(botToken, chatId);
      if (generation !== context.runtimeState.telegramConfigurationGeneration) {
        throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer Telegram configuration change superseded this request");
      }
      context.notificationOutbox.fenceTelegramConfigurationChange();
      updateIntegrationSecrets(config.integrationSecretsFile, { telegram: { botToken, chatId } });
      context.integrationMetadata.saveTelegramIdentity({
        botUsername: identity.botUsername,
        chatLabel: identity.chatLabel,
      });
      config.telegramBotToken = botToken;
      config.telegramChatId = chatId;
      context.runtimeState.telegramDeliveryGeneration += 1;
      const telegramStatus = context.status.value.telegram!;
      telegramStatus.configured = true;
      telegramStatus.connected = false;
      telegramStatus.botUsername = identity.botUsername;
      telegramStatus.chatLabel = identity.chatLabel;
      telegramStatus.lastDeliveryAt = null;
      telegramStatus.error = null;
      context.status.changed();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: rotatingCredentials ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: "telegram",
        details: { integration: "telegram" },
      });
      response.json({ ok: true, configured: true, integration: structuredClone(context.status.value) });
    });
  context.app.post(`${context.prefix}/integrations/telegram/test`, requireWorkspaceAdmin, async (_request, response) => {
      if (!config.telegramBotToken || !config.telegramChatId) {
        throw new HttpError(409, "TELEGRAM_NOT_CONFIGURED", "Configure a Telegram bot and private chat before sending a test message");
      }
      const botToken = config.telegramBotToken;
      const chatId = config.telegramChatId;
      const telegramStatus = context.status.value.telegram!;
      try {
        const identity = await context.telegram.verify(botToken, chatId);
        context.integrationMetadata.saveTelegramIdentity({
          botUsername: identity.botUsername,
          chatLabel: identity.chatLabel,
          reason: "identity-refreshed",
        });
        await context.telegram.sendTest(botToken, chatId);
        telegramStatus.connected = true;
        telegramStatus.botUsername = identity.botUsername;
        telegramStatus.chatLabel = identity.chatLabel;
        telegramStatus.lastDeliveryAt = new Date().toISOString();
        telegramStatus.error = null;
        context.status.changed();
        response.json({ ok: true, message: "The Telegram test message was delivered." });
      } catch (error) {
        telegramStatus.connected = false;
        telegramStatus.error = error instanceof TelegramServiceError ? error.message : "Telegram test delivery failed";
        context.status.changed();
        throw error;
      }
    });
  context.app.delete(`${context.prefix}/integrations/telegram/config`, requireWorkspaceAdmin, (_request, response) => {
      context.runtimeState.telegramConfigurationGeneration += 1;
      context.notificationOutbox.fenceTelegramConfigurationChange();
      updateIntegrationSecrets(config.integrationSecretsFile, { telegram: null });
      context.integrationMetadata.retireTelegram();
      config.telegramBotToken = null;
      config.telegramChatId = null;
      context.runtimeState.telegramDeliveryGeneration += 1;
      const telegramStatus = context.status.value.telegram!;
      telegramStatus.configured = false;
      telegramStatus.connected = false;
      telegramStatus.botUsername = null;
      telegramStatus.chatLabel = null;
      telegramStatus.lastDeliveryAt = null;
      telegramStatus.error = null;
      context.status.changed();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.revoked",
        subjectType: "integration",
        subjectId: "telegram",
        details: { integration: "telegram" },
      });
      response.json({ ok: true, integration: structuredClone(context.status.value) });
    });
  context.app.get(`${context.prefix}/integrations/telegram/setup`, (_request, response) => response.json({
      available: true,
      configured: context.status.value.telegram!.configured,
      privateChatsOnly: true,
      steps: [
        "Open @BotFather in Telegram, create a bot, and copy its bot token.",
        "Open the new bot from the intended private Telegram account and send /start.",
        "Enter the bot token in Stugu, discover private chats, select the recipient, and save.",
        "Send a test message, then enable Telegram on each alert rule that should notify this chat.",
      ],
      privacy: [
        "The bot token is write-only through the API and is stored in the protected local integration secrets file, never SQLite.",
        "Alert messages contain only the house and sensor labels, rule, metric, value, threshold, severity, and time; Telegram content protection is enabled.",
        "Mock and replay data never trigger Telegram delivery. Informational alerts are delivered silently.",
      ],
      limitations: [
        "Only one private chat can be configured in this local Stugu instance.",
        "Groups, channels, topics, attachments, and Telegram account credentials are not supported.",
        "Telegram has no idempotency key for Bot API sends. Durable retries are at-least-once, so an ambiguous crash or network failure can produce a duplicate alert.",
      ],
    }));
}
