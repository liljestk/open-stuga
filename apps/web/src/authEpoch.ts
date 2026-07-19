const AUTH_CHANNEL_NAME = "stuga-local-auth-epoch";
const AUTH_EPOCH_TYPE = "auth-epoch";

type AuthEpochMessage = { type: typeof AUTH_EPOCH_TYPE; epoch: string };

let channel: BroadcastChannel | null | undefined;

function authChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof globalThis.BroadcastChannel === "function"
      ? new globalThis.BroadcastChannel(AUTH_CHANNEL_NAME)
      : null;
  } catch {
    channel = null;
  }
  return channel;
}

function nextEpoch(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function publishAuthEpoch(): void {
  try {
    authChannel()?.postMessage({ type: AUTH_EPOCH_TYPE, epoch: nextEpoch() } satisfies AuthEpochMessage);
  } catch {
    // Cross-tab invalidation is defense in depth; the local auth request must
    // still complete if a browser policy disables BroadcastChannel.
  }
}

export function subscribeToAuthEpoch(listener: () => void): () => void {
  const current = authChannel();
  if (!current) return () => undefined;
  const receive = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!value || typeof value !== "object") return;
    const message = value as Partial<AuthEpochMessage>;
    if (message.type === AUTH_EPOCH_TYPE && typeof message.epoch === "string" && message.epoch.length <= 200) listener();
  };
  try {
    current.addEventListener("message", receive);
    return () => current.removeEventListener("message", receive);
  } catch {
    return () => undefined;
  }
}
