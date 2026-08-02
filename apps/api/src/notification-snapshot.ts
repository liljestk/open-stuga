import { createHash } from "node:crypto";
import type { AlertEvent, AlertRule } from "@climate-twin/contracts";
import type { NotificationDeliveryStage } from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "./config.js";
import { renderTelegramAlertText, type TelegramAlertContext } from "./telegram.js";
import type { APNSDestination } from "./apns.js";

export type NotificationSnapshotChannel = "webhook" | "telegram" | "apns";

export interface WebhookNotificationBinding {
  destinationId: string;
  destinationRef: string;
}

export interface AlertNotificationBindings extends TelegramAlertContext {
  webhookDestinations: WebhookNotificationBinding[];
  telegramDestinationRef: string;
  apnsProviderRef: string;
  apnsEnabled: boolean;
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

export interface APNSNotificationPayload {
  aps: {
    alert: { title: string; body: string };
    category: "STUGA_ALERT" | "STUGA_ALERT_READ_ONLY";
    sound?: "default";
    "thread-id": string;
  };
  stuguAlertId: string;
  stuguDeepLink: string;
}

/** Immutable, credential-free snapshot for maintenance and action-run notices. */
export function operationalNotificationSnapshot(
  channel: Exclude<NotificationSnapshotChannel, "apns">,
  config: AppConfig | undefined,
  input: { type: "maintenance.due" | "action.verification" | "system.health"; subjectId: string; text: string; data: unknown; silent: boolean },
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
  if (channel === "apns") {
    return `apns:${destinationId}:unbound`;
  }
  return `telegram:sha256:${digest([config?.telegramBotToken ?? null, config?.telegramChatId ?? null])}`;
}

export function apnsProviderRef(config: AppConfig | undefined): string {
  return `apns-provider:sha256:${digest([
    config?.apnsTeamId ?? null,
    config?.apnsKeyId ?? null,
    config?.apnsBundleId ?? null,
    config?.apnsPrivateKey ?? null,
  ])}`;
}

export function apnsNotificationDestinationRef(
  providerRef: string,
  destination: APNSDestination | null,
): string {
  return `apns:sha256:${digest([
    providerRef,
    destination?.registrationId ?? null,
    destination?.deviceToken ?? null,
    destination?.environment ?? null,
    destination?.includeDetails ? "details" : "private",
    destination?.canAcknowledge ? "writable" : "read-only",
  ])}`;
}

function boundedPushText(value: string, maximumCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maximumCharacters
    ? value
    : `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

export function apnsNotificationSnapshot(
  event: AlertEvent,
  rule: AlertRule,
  bindings: Pick<AlertNotificationBindings, "houseLabel" | "sensorLabel">,
  destination: APNSDestination,
  providerRef: string,
  silentOverride?: boolean,
  stage: NotificationDeliveryStage = "initial",
): NotificationSnapshot {
  const prefix = stage === "escalation" ? "Escalation: " : stage === "reminder" ? "Reminder: " : "";
  const privateTitle = event.severity === "critical" ? "Stugu needs urgent attention" : "Stugu needs attention";
  const detailedTitle = boundedPushText(bindings.houseLabel
    ? `${prefix}${rule.name} · ${bindings.houseLabel}`
    : `${prefix}${rule.name}`, 180);
  const detailedBody = boundedPushText(bindings.sensorLabel
    ? `${bindings.sensorLabel} has an active ${event.severity} alert.`
    : `An active ${event.severity} alert needs review.`, 400);
  const payload: APNSNotificationPayload = {
    aps: {
      alert: {
        title: destination.includeDetails ? detailedTitle : privateTitle,
        body: destination.includeDetails
          ? detailedBody
          : "Open Stugu to review the current alert.",
      },
      category: destination.canAcknowledge ? "STUGA_ALERT" : "STUGA_ALERT_READ_ONLY",
      ...((silentOverride ?? rule.severity === "info") ? {} : { sound: "default" as const }),
      "thread-id": "stugu-alerts",
    },
    stuguAlertId: event.id,
    stuguDeepLink: `stugu://alerts?id=${encodeURIComponent(event.id)}`,
  };
  return {
    destinationRef: apnsNotificationDestinationRef(providerRef, destination),
    payloadJson: JSON.stringify(payload),
  };
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
    apnsProviderRef: apnsProviderRef(config),
    apnsEnabled: Boolean(
      config?.apnsTeamId
        && config.apnsKeyId
        && config.apnsBundleId
        && config.apnsPrivateKey,
    ),
  };
}

export function notificationSnapshot(
  channel: Exclude<NotificationSnapshotChannel, "apns">,
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
