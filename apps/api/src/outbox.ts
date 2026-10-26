import { createHmac } from "node:crypto";
import { configuredAlertWebhookDestinations, type AppConfig } from "./config.js";
import type { ClimateDatabase, NotificationOutboxItem } from "./db.js";
import type { RuntimeStatus } from "./services.js";
import { TelegramService } from "./telegram.js";
import { APNSDeliveryError, APNSService } from "./apns.js";
import {
  apnsNotificationDestinationRef,
  apnsProviderRef,
  notificationDestinationRef,
  parseTelegramNotificationPayload,
} from "./notification-snapshot.js";
import { compareCodeUnits } from "./text-order.js";

const DELIVERY_POLL_MS = 250;
const MAX_RETRY_MS = 15 * 60_000;
const HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const DELIVERED_HISTORY_RETENTION_MS = 180 * 24 * 60 * 60_000;
const TERMINAL_HISTORY_RETENTION_MS = 365 * 24 * 60 * 60_000;

export interface NotificationDeliveryFailure {
  channel: NotificationOutboxItem["channel"];
  subjectKind: NotificationOutboxItem["subjectKind"];
  message: string;
  terminal: boolean;
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(attempts, 10));
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try { await response.body.cancel(); } catch { /* The status still determines delivery outcome. */ }
}

abstract class DurableWorker {
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #stopping = false;

  start(): void {
    if (this.#timer || this.#stopping) return;
    this.#timer = setInterval(() => this.wake(), DELIVERY_POLL_MS);
    this.#timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.#stopping || this.#active) return;
    const controller = new AbortController();
    this.#controller = controller;
    const active = this.runOnce(controller.signal).catch(() => undefined).finally(() => {
      if (this.#active === active) this.#active = null;
      if (this.#controller === controller) this.#controller = null;
    });
    this.#active = active;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    const active = this.#active;
    if (!active) return;
    await active;
  }

  protected abortActive(): void {
    this.#controller?.abort();
  }

  protected abstract runOnce(signal: AbortSignal): Promise<void>;
}

export class NotificationOutboxWorker extends DurableWorker {
  #nextHistoryPruneAt = 0;

  constructor(
    private readonly database: ClimateDatabase,
    private readonly config: AppConfig,
    private readonly status: RuntimeStatus,
    private readonly telegram = new TelegramService(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly telegramConfigurationGeneration: () => number = () => 0,
    private readonly apns: Pick<APNSService, "send"> = new APNSService(),
    private readonly onDeliveryFailure?: (failure: NotificationDeliveryFailure) => void,
  ) { super(); }

  fenceTelegramConfigurationChange(): void {
    // Abort any request using the prior credential tuple. The durable row is
    // released by the active delivery and will be retried with the committed
    // tuple; an already accepted Bot API request remains inherently at-least-once.
    this.abortActive();
  }

  protected async runOnce(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    if (now >= this.#nextHistoryPruneAt) {
      this.#nextHistoryPruneAt = now + HISTORY_PRUNE_INTERVAL_MS;
      this.database.pruneNotificationDeliveryHistory(
        new Date(now - DELIVERED_HISTORY_RETENTION_MS),
        new Date(now - TERMINAL_HISTORY_RETENTION_MS),
      );
    }
    const items = this.database.claimNotificationOutbox(10);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (signal.aborted) {
        for (const pending of items.slice(index)) {
          this.database.releaseNotificationOutbox(pending.id, pending.lockToken);
        }
        return;
      }
      await this.deliver(item, signal);
    }
  }

  private async deliver(item: NotificationOutboxItem, signal: AbortSignal): Promise<void> {
    const telegramGeneration = this.telegramConfigurationGeneration();
    const telegramToken = this.config.telegramBotToken;
    const telegramChatId = this.config.telegramChatId;
    const webhookDestination = item.channel === "webhook"
      ? configuredAlertWebhookDestinations(this.config).find((destination) => destination.id === item.destinationId)
      : undefined;
    const apnsDestination = item.channel === "apns" && item.eventId
      ? this.database.getIOSPushDestinationForAlert(item.destinationId, item.eventId)
      : null;
    try {
      const currentDestinationRef = item.channel === "apns"
        ? apnsNotificationDestinationRef(apnsProviderRef(this.config), apnsDestination)
        : notificationDestinationRef(item.channel, this.config, item.destinationId);
      if (item.destinationRef !== currentDestinationRef) {
        this.database.abandonNotificationOutbox(
          item.id,
          item.lockToken,
          "Notification destination configuration changed after this item was queued",
        );
        this.status.changed();
        return;
      }
      if (item.channel === "webhook") {
        const destination = webhookDestination;
        if (!destination) {
          this.database.abandonNotificationOutbox(
            item.id,
            item.lockToken,
            "Notification destination configuration was removed after this item was queued",
          );
          this.status.changed();
          return;
        }
        const webhookHost = new URL(destination.url).hostname.toLowerCase();
        if (!(this.config.alertWebhookAllowedHosts ?? []).includes(webhookHost)) {
          throw new Error("Alert webhook destination is not on the configured allowlist");
        }
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "idempotency-key": `stugu-${item.subjectKind}-${item.subjectId}-${item.stage}-${item.sequence}-${item.destinationId}`,
        };
        if (destination.bearerToken) headers.authorization = `Bearer ${destination.bearerToken}`;
        if (destination.signingSecret) {
          const timestamp = Math.floor(Date.now() / 1_000).toString();
          const signature = createHmac("sha256", destination.signingSecret)
            .update(`${timestamp}.${item.payloadJson}`, "utf8")
            .digest("hex");
          headers["x-stugu-timestamp"] = timestamp;
          headers["x-stugu-signature"] = `sha256=${signature}`;
        }
        const response = await this.fetchImpl(destination.url, {
          method: "POST",
          headers,
          body: item.payloadJson,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        await discardResponseBody(response);
        if (signal.aborted) {
          this.database.releaseNotificationOutbox(item.id, item.lockToken);
          return;
        }
        if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
        this.updateWebhookStatus(item.destinationId, new Date().toISOString(), null);
      } else if (item.channel === "telegram") {
        if (!telegramToken || !telegramChatId) throw new Error("Telegram is not configured");
        const payload = parseTelegramNotificationPayload(item.payloadJson);
        await this.telegram.sendRenderedAlert(telegramToken, telegramChatId, payload.text, payload.silent, signal);
        if (signal.aborted) {
          this.database.releaseNotificationOutbox(item.id, item.lockToken);
          return;
        }
        if (telegramGeneration !== this.telegramConfigurationGeneration()
          || telegramToken !== this.config.telegramBotToken || telegramChatId !== this.config.telegramChatId) {
          this.database.releaseNotificationOutbox(item.id, item.lockToken);
          return;
        }
        const telegramStatus = this.status.value.telegram!;
        telegramStatus.connected = true;
        telegramStatus.lastDeliveryAt = new Date().toISOString();
        telegramStatus.error = null;
      } else {
        if (!apnsDestination) {
          throw new APNSDeliveryError("iOS notification registration is no longer active", true);
        }
        await this.apns.send(
          this.config,
          apnsDestination,
          item.payloadJson,
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          item.id,
        );
        if (signal.aborted) {
          this.database.releaseNotificationOutbox(item.id, item.lockToken);
          return;
        }
      }
      this.database.completeNotificationOutbox(item.id, item.lockToken);
    } catch (error) {
      if (signal.aborted) {
        this.database.releaseNotificationOutbox(item.id, item.lockToken);
        return;
      }
      if (item.channel === "telegram" && (telegramGeneration !== this.telegramConfigurationGeneration()
        || telegramToken !== this.config.telegramBotToken || telegramChatId !== this.config.telegramChatId)) {
        this.database.releaseNotificationOutbox(item.id, item.lockToken);
        return;
      }
      const message = error instanceof Error ? error.message : "Notification delivery failed";
      const terminal = item.attempts + 1 >= item.maxAttempts
        || (item.channel === "apns" && error instanceof APNSDeliveryError && error.terminal);
      if (item.attempts === 0 || terminal) {
        this.onDeliveryFailure?.({ channel: item.channel, subjectKind: item.subjectKind, message, terminal });
      }
      if (item.channel === "apns" && error instanceof APNSDeliveryError && error.terminal) {
        if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(error.reason ?? "")) {
          this.database.disableIOSNotificationRegistration(item.destinationId);
        }
        this.database.deadLetterNotificationOutbox(item.id, item.lockToken, message);
        this.status.changed();
        return;
      }
      if (item.attempts + 1 >= item.maxAttempts) {
        this.database.deadLetterNotificationOutbox(item.id, item.lockToken, message);
      } else {
        this.database.failNotificationOutbox(
          item.id,
          item.lockToken,
          message,
          new Date(Date.now() + retryDelay(item.attempts)),
        );
      }
      if (item.channel === "webhook") this.updateWebhookStatus(item.destinationId, null, message);
      else if (item.channel === "telegram") {
        this.status.value.telegram!.connected = false;
        this.status.value.telegram!.error = "Telegram alert delivery failed";
      }
    }
    this.status.changed();
  }

  private updateWebhookStatus(destinationId: string, deliveredAt: string | null, error: string | null): void {
    const webhook = this.status.value.webhook;
    const destinations = webhook.destinations ?? [];
    const destination = destinations.find((candidate) => candidate.id === destinationId);
    if (destination) {
      if (deliveredAt) destination.lastDeliveryAt = deliveredAt;
      destination.error = error;
    }
    webhook.lastDeliveryAt = destinations.map((candidate) => candidate.lastDeliveryAt)
      .filter((value): value is string => value !== null)
      .sort(compareCodeUnits).at(-1) ?? deliveredAt ?? webhook.lastDeliveryAt;
    const failing = destinations.filter((candidate) => candidate.error !== null).length;
    webhook.error = failing > 0
      ? `${failing} webhook destination${failing === 1 ? "" : "s"} failing`
      : destinations.length > 0
        ? null
        : error;
  }
}
