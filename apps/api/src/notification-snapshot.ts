import { createHash } from "node:crypto";
import type { AlertEvent, AlertRule } from "@climate-twin/contracts";
import type { NotificationDeliveryStage } from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "./config.js";
import { renderTelegramAlertText, type TelegramAlertContext } from "./telegram.js";

export type NotificationSnapshotChannel = "webhook" | "telegram";

export interface WebhookNotificationBinding {
  destinationId: string;
  destinationRef: string;
}

export interface AlertNotificationBindings extends TelegramAlertContext {
  webhookDestinations: WebhookNotificationBinding[];
  telegramDestinationRef: string;
}

export interface NotificationSnapshot {
  payloadJson: string;
  destinationRef: string;
}

export interface TelegramNotificationPayload {
  version: 1;
  text: string;
  silent: boolean;
}

/** Immutable, credential-free snapshot for maintenance and action-run notices. */
export function operationalNotificationSnapshot(
  channel: NotificationSnapshotChannel,
  config: AppConfig | undefined,
  input: { type: "maintenance.due" | "action.verification"; subjectId: string; text: string; data: unknown; silent: boolean },
  destinationId = "primary",
): NotificationSnapshot {
  if (channel === "webhook") {
    return {
      destinationRef: notificationDestinationRef(channel, config, destinationId),
      payloadJson: JSON.stringify({ apiVersion: "v1", type: `climate-twin.${input.type}`, subjectId: input.subjectId, data: input.data }),
    };
  }
  return {
    destinationRef: notificationDestinationRef(channel, config),
    payloadJson: JSON.stringify({ version: 1, text: input.text, silent: input.silent } satisfies TelegramNotificationPayload),
  };
}

function digest(parts: readonly (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/**
 * Stable, one-way reference to a complete delivery credential tuple. The
 * credential itself remains in the protected integration-secret source, while
 * a queued row can prove that it is still addressed to the same destination.
 */
export function notificationDestinationRef(
  channel: NotificationSnapshotChannel,
  config?: AppConfig,
  destinationId = "primary",
): string {
  if (channel === "webhook") {
    const destination = config
      ? configuredAlertWebhookDestinations(config).find((candidate) => candidate.id === destinationId)
      : undefined;
    const prefix = destinationId === "primary" ? "webhook:sha256" : `webhook:${destinationId}:sha256`;
    return `${prefix}:${digest([
      destination?.url ?? null,
      destination?.bearerToken ?? null,
      destination?.signingSecret ?? null,
    ])}`;
  }
  return `telegram:sha256:${digest([config?.telegramBotToken ?? null, config?.telegramChatId ?? null])}`;
}

export function alertNotificationBindings(
  config: AppConfig | undefined,
  context: TelegramAlertContext,
): AlertNotificationBindings {
  const configuredWebhooks = config ? configuredAlertWebhookDestinations(config) : [];
  const webhookDestinations = (configuredWebhooks.length > 0
    ? configuredWebhooks.map((destination) => destination.id)
    : ["primary"])
    .map((destinationId) => ({
      destinationId,
      destinationRef: notificationDestinationRef("webhook", config, destinationId),
    }));
  return {
    ...context,
    webhookDestinations,
    telegramDestinationRef: notificationDestinationRef("telegram", config),
  };
}

export function notificationSnapshot(
  channel: NotificationSnapshotChannel,
  event: AlertEvent,
  rule: AlertRule,
  bindings: AlertNotificationBindings,
  silentOverride?: boolean,
  stage: NotificationDeliveryStage = "initial",
  destinationId = "primary",
): NotificationSnapshot {
  if (channel === "webhook") {
    const destinationRef = bindings.webhookDestinations
      .find((destination) => destination.destinationId === destinationId)?.destinationRef;
    if (!destinationRef) throw new Error(`Webhook notification destination ${destinationId} is not bound`);
    return {
      destinationRef,
      payloadJson: JSON.stringify({ apiVersion: "v1", type: "climate-twin.alert", deliveryStage: stage, event, rule }),
    };
  }
  const prefix = stage === "escalation" ? "ESCALATION — " : stage === "reminder" ? "Reminder — " : "";
  const payload: TelegramNotificationPayload = {
    version: 1,
    text: `${prefix}${renderTelegramAlertText(event, rule, bindings)}`,
    silent: silentOverride ?? rule.severity === "info",
  };
  return { destinationRef: bindings.telegramDestinationRef, payloadJson: JSON.stringify(payload) };
}

export function legacyNotificationDestinationRef(channel: NotificationSnapshotChannel): string {
  return `${channel}:legacy-unbound`;
}

export function parseTelegramNotificationPayload(payloadJson: string): TelegramNotificationPayload {
  const value = JSON.parse(payloadJson) as Partial<TelegramNotificationPayload> | null;
  if (!value || value.version !== 1 || typeof value.text !== "string" || value.text.length === 0
    || value.text.length > 4_096 || typeof value.silent !== "boolean") {
    throw new Error("Queued Telegram notification payload is invalid");
  }
  return { version: 1, text: value.text, silent: value.silent };
}
