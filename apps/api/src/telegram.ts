import type {
  AlertEvent,
  AlertRule,
  TelegramChatCandidate,
  TelegramDiscoveryResult,
} from "@climate-twin/contracts";

type TelegramErrorCode = "INVALID_INPUT" | "INVALID_CREDENTIALS" | "RATE_LIMITED" | "UNAVAILABLE" | "INVALID_RESPONSE";

export class TelegramServiceError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    message: string,
    readonly status: 400 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = "TelegramServiceError";
  }
}

interface TelegramBotIdentity {
  botUsername: string;
}

interface TelegramChatIdentity extends TelegramBotIdentity {
  chatLabel: string;
}

export interface TelegramAlertContext {
  houseLabel: string | null;
  sensorLabel: string | null;
}

interface TelegramChat {
  id?: unknown;
  type?: unknown;
  username?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  title?: unknown;
}

function botToken(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9:_-]+$/.test(normalized)) {
    throw new TelegramServiceError("INVALID_INPUT", "botToken must be a valid Telegram bot token", 400);
  }
  return normalized;
}

function telegramChatId(value: string): string {
  const normalized = value.trim();
  if (!/^-?\d{1,20}$/.test(normalized)) {
    throw new TelegramServiceError("INVALID_INPUT", "chatId must be a numeric Telegram chat identifier", 400);
  }
  return normalized;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function chatIdString(value: unknown): string | null {
  if (typeof value === "string" && /^-?\d{1,20}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function chatCandidate(value: unknown): TelegramChatCandidate | null {
  const chat = record(value) as TelegramChat | null;
  if (!chat || chat.type !== "private") return null;
  const id = chatIdString(chat.id);
  if (!id) return null;
  const username = typeof chat.username === "string" && chat.username.trim() ? chat.username.trim() : null;
  const personName = [chat.first_name, chat.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" ");
  return {
    id,
    label: personName || (username ? `@${username}` : `Private chat ${id}`),
    username,
    type: "private",
  };
}

function updateChat(value: unknown): TelegramChatCandidate | null {
  const update = record(value);
  if (!update) return null;
  for (const key of ["message", "edited_message", "my_chat_member"] as const) {
    const container = record(update[key]);
    const candidate = chatCandidate(container?.chat);
    if (candidate) return candidate;
  }
  return null;
}

function plainLine(value: string, maximumLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

export function renderTelegramAlertText(event: AlertEvent, rule: AlertRule, context?: TelegramAlertContext): string {
  const lines = [
    `Stuga ${rule.severity.toUpperCase()} alert`,
    plainLine(rule.name, 200),
    ...(context?.houseLabel ? [`House: ${plainLine(context.houseLabel, 200)}`] : []),
    `${plainLine(event.metric, 64)}: ${event.value} (threshold ${event.threshold})`,
    `Sensor: ${plainLine(context?.sensorLabel ?? event.sensorId, 200)}`,
    `Started: ${event.startedAt}`,
  ];
  const text = lines.filter(Boolean).join("\n");
  return text.length <= 4_096 ? text : `${text.slice(0, 4_095)}…`;
}

export class TelegramService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async discover(token: string): Promise<TelegramDiscoveryResult> {
    const normalizedToken = botToken(token);
    const identity = await this.botIdentity(normalizedToken);
    const updates = await this.request(normalizedToken, "getUpdates", {
      allowed_updates: ["message", "edited_message", "my_chat_member"],
      limit: 100,
      timeout: 0,
    });
    if (!Array.isArray(updates)) {
      throw new TelegramServiceError("INVALID_RESPONSE", "Telegram returned an invalid chat discovery response");
    }
    const chats = new Map<string, TelegramChatCandidate>();
    for (const update of updates) {
      const candidate = updateChat(update);
      if (candidate) chats.set(candidate.id, candidate);
    }
    const values = [...chats.values()].sort((left, right) => left.label.localeCompare(right.label));
    return {
      botUsername: identity.botUsername,
      chats: values,
      message: values.length
        ? "Select the private chat that should receive Stuga alerts."
        : "No private chats were found. Open the bot in Telegram, send /start, then try again.",
    };
  }

  async verify(token: string, chatId: string): Promise<TelegramChatIdentity> {
    const normalizedToken = botToken(token);
    const normalizedChatId = telegramChatId(chatId);
    const [identity, result] = await Promise.all([
      this.botIdentity(normalizedToken),
      this.request(normalizedToken, "getChat", { chat_id: normalizedChatId }),
    ]);
    const chat = chatCandidate(result);
    if (!chat || chat.id !== normalizedChatId) {
      throw new TelegramServiceError("INVALID_INPUT", "The selected Telegram chat must be a private chat", 400);
    }
    return { ...identity, chatLabel: chat.label };
  }

  async sendTest(token: string, chatId: string): Promise<void> {
    await this.sendMessage(token, chatId, "Stuga Telegram alerts are connected.", false);
  }

  async sendAlert(
    token: string,
    chatId: string,
    event: AlertEvent,
    rule: AlertRule,
    context?: TelegramAlertContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sendRenderedAlert(token, chatId, renderTelegramAlertText(event, rule, context), rule.severity === "info", signal);
  }

  async sendRenderedAlert(
    token: string,
    chatId: string,
    text: string,
    silent: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sendMessage(token, chatId, text, silent, signal);
  }

  private async botIdentity(token: string): Promise<TelegramBotIdentity> {
    const result = record(await this.request(token, "getMe"));
    const username = result?.username;
    if (typeof username !== "string" || !username.trim()) {
      throw new TelegramServiceError("INVALID_RESPONSE", "Telegram returned an invalid bot identity");
    }
    return { botUsername: username.trim() };
  }

  private async sendMessage(token: string, chatId: string, text: string, silent: boolean, signal?: AbortSignal): Promise<void> {
    await this.request(botToken(token), "sendMessage", {
      chat_id: telegramChatId(chatId),
      text,
      protect_content: true,
      disable_notification: silent,
    }, signal);
  }

  private async request(
    token: string,
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TelegramServiceError("UNAVAILABLE", "Telegram could not be reached", 503);
    }

    let payload: Record<string, unknown> | null = null;
    try {
      payload = record(await response.json());
    } catch {
      // A generic response below deliberately avoids echoing Telegram URLs or bodies.
    }
    if (response.status === 401 || response.status === 404) {
      throw new TelegramServiceError("INVALID_CREDENTIALS", "Telegram rejected the bot credentials", 400);
    }
    if (response.status === 429) {
      throw new TelegramServiceError("RATE_LIMITED", "Telegram is temporarily rate limiting messages", 503);
    }
    if (!response.ok || payload?.ok === false) {
      throw new TelegramServiceError("UNAVAILABLE", "Telegram rejected the request", 502);
    }
    if (payload?.ok !== true || !("result" in payload)) {
      throw new TelegramServiceError("INVALID_RESPONSE", "Telegram returned an invalid response", 502);
    }
    return payload.result;
  }
}
