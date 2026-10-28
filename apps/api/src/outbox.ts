import { createHmac } from "node:crypto";
import { configuredAlertWebhookDestinations, type AppConfig } from "./config.js";
import type { ClimateDatabase, NotificationOutboxItem } from "./db.js";
import type { RuntimeStatus } from "./runtime-status.js";
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

type WebhookDestination = ReturnType<typeof configuredAlertWebhookDestinations>[number];

// One claimed outbox row plus the destination and Telegram credentials it was claimed against.
interface Delivery {
  item: NotificationOutboxItem;
  signal: AbortSignal;
  telegram: { generation: number; token: string | null; chatId: string | null };
  webhookDestination: WebhookDestination | undefined;
  apnsDestination: ReturnType<ClimateDatabase["getIOSPushDestinationForAlert"]>;
}

// "stopped" means the row was already released or settled and the status needs no further change.
type DeliveryStep = "continue" | "stopped";

function webhookHeaders(item: NotificationOutboxItem, destination: WebhookDestination): Record<string, string> {
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
  return headers;
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

/** Delivery transports and hooks; each defaults to the production implementation. */
export interface NotificationOutboxOptions {
  telegram?: TelegramService;
  fetchImpl?: typeof fetch;
  /** Changes whenever the Telegram credentials change, fencing deliveries made with older ones. */
  telegramConfigurationGeneration?: () => number;
  apns?: Pick<APNSService, "send">;
  onDeliveryFailure?: (failure: NotificationDeliveryFailure) => void;
}

export class NotificationOutboxWorker extends DurableWorker {
  #nextHistoryPruneAt = 0;
  private readonly telegram: TelegramService;
  private readonly fetchImpl: typeof fetch;
  private readonly telegramConfigurationGeneration: () => number;
  private readonly apns: Pick<APNSService, "send">;
  private readonly onDeliveryFailure: ((failure: NotificationDeliveryFailure) => void) | undefined;

  constructor(
    private readonly database: ClimateDatabase,
    private readonly config: AppConfig,
    private readonly status: RuntimeStatus,
    {
      telegram = new TelegramService(),
      fetchImpl = fetch,
      telegramConfigurationGeneration = () => 0,
      apns = new APNSService(),
      onDeliveryFailure,
    }: NotificationOutboxOptions = {},
  ) {
    super();
    this.telegram = telegram;
    this.fetchImpl = fetchImpl;
    this.telegramConfigurationGeneration = telegramConfigurationGeneration;
    this.apns = apns;
    this.onDeliveryFailure = onDeliveryFailure;
  }

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
    const delivery: Delivery = {
      item,
      signal,
      telegram: {
        generation: this.telegramConfigurationGeneration(),
        token: this.config.telegramBotToken,
        chatId: this.config.telegramChatId,
      },
      webhookDestination: item.channel === "webhook"
        ? configuredAlertWebhookDestinations(this.config).find((destination) => destination.id === item.destinationId)
        : undefined,
      apnsDestination: item.channel === "apns" && item.eventId
        ? this.database.getIOSPushDestinationForAlert(item.destinationId, item.eventId)
        : null,
    };
    try {
      if (await this.send(delivery) === "stopped") return;
      this.database.completeNotificationOutbox(item.id, item.lockToken);
    } catch (error) {
      if (this.recordDeliveryFailure(delivery, error) === "stopped") return;
    }
    this.status.changed();
  }

  private async send(delivery: Delivery): Promise<DeliveryStep> {
    const { item } = delivery;
    const currentDestinationRef = item.channel === "apns"
      ? apnsNotificationDestinationRef(apnsProviderRef(this.config), delivery.apnsDestination)
      : notificationDestinationRef(item.channel, this.config, item.destinationId);
    if (item.destinationRef !== currentDestinationRef) {
      this.abandon(item, "Notification destination configuration changed after this item was queued");
      return "stopped";
    }
    if (item.channel === "webhook") return this.sendWebhook(delivery);
    if (item.channel === "telegram") return this.sendTelegram(delivery);
    return this.sendApns(delivery);
  }

  private abandon(item: NotificationOutboxItem, reason: string): void {
    this.database.abandonNotificationOutbox(item.id, item.lockToken, reason);
    this.status.changed();
  }

  // An aborted worker hands the claimed row back untouched for the next run.
  private releaseIfAborted({ item, signal }: Delivery): DeliveryStep {
    if (!signal.aborted) return "continue";
    this.database.releaseNotificationOutbox(item.id, item.lockToken);
    return "stopped";
  }

  private async sendWebhook(delivery: Delivery): Promise<DeliveryStep> {
    const { item, signal, webhookDestination: destination } = delivery;
    if (!destination) {
      this.abandon(item, "Notification destination configuration was removed after this item was queued");
      return "stopped";
    }
    const webhookHost = new URL(destination.url).hostname.toLowerCase();
    if (!(this.config.alertWebhookAllowedHosts ?? []).includes(webhookHost)) {
      throw new Error("Alert webhook destination is not on the configured allowlist");
    }
    const response = await this.fetchImpl(destination.url, {
      method: "POST",
      headers: webhookHeaders(item, destination),
      body: item.payloadJson,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    await discardResponseBody(response);
    if (this.releaseIfAborted(delivery) === "stopped") return "stopped";
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    this.updateWebhookStatus(item.destinationId, new Date().toISOString(), null);
    return "continue";
  }

  private async sendTelegram(delivery: Delivery): Promise<DeliveryStep> {
    const { item, signal, telegram } = delivery;
    if (!telegram.token || !telegram.chatId) throw new Error("Telegram is not configured");
    const payload = parseTelegramNotificationPayload(item.payloadJson);
    await this.telegram.sendRenderedAlert(telegram.token, telegram.chatId, payload.text, payload.silent, signal);
    if (this.releaseIfAborted(delivery) === "stopped") return "stopped";
    if (this.telegramConfigurationChanged(telegram)) {
      this.database.releaseNotificationOutbox(item.id, item.lockToken);
      return "stopped";
    }
    const telegramStatus = this.status.value.telegram!;
    telegramStatus.connected = true;
    telegramStatus.lastDeliveryAt = new Date().toISOString();
    telegramStatus.error = null;
    return "continue";
  }

  private async sendApns(delivery: Delivery): Promise<DeliveryStep> {
    const { item, signal, apnsDestination } = delivery;
    if (!apnsDestination) {
      throw new APNSDeliveryError("iOS notification registration is no longer active", true);
    }
    await this.apns.send(this.config, apnsDestination, {
      payloadJson: item.payloadJson,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      notificationId: item.id,
    });
    return this.releaseIfAborted(delivery);
  }

  private telegramConfigurationChanged(snapshot: Delivery["telegram"]): boolean {
    return snapshot.generation !== this.telegramConfigurationGeneration()
      || snapshot.token !== this.config.telegramBotToken || snapshot.chatId !== this.config.telegramChatId;
  }

  private recordDeliveryFailure(delivery: Delivery, error: unknown): DeliveryStep {
    const { item } = delivery;
    if (this.releaseIfAborted(delivery) === "stopped") return "stopped";
    if (item.channel === "telegram" && this.telegramConfigurationChanged(delivery.telegram)) {
      this.database.releaseNotificationOutbox(item.id, item.lockToken);
      return "stopped";
    }
    const message = error instanceof Error ? error.message : "Notification delivery failed";
    const terminalApnsError = item.channel === "apns" && error instanceof APNSDeliveryError && error.terminal ? error : null;
    const exhausted = item.attempts + 1 >= item.maxAttempts;
    const terminal = exhausted || terminalApnsError !== null;
    if (item.attempts === 0 || terminal) {
      this.onDeliveryFailure?.({ channel: item.channel, subjectKind: item.subjectKind, message, terminal });
    }
    if (terminalApnsError) {
      if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(terminalApnsError.reason ?? "")) {
        this.database.disableIOSNotificationRegistration(item.destinationId);
      }
      this.database.deadLetterNotificationOutbox(item.id, item.lockToken, message);
      this.status.changed();
      return "stopped";
    }
    if (exhausted) {
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
    return "continue";
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
