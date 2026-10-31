import type { AssistantKind } from "@climate-twin/contracts";

/**
 * Registration is open to anyone who can reach the token endpoint, so the
 * redirect address is what decides who an approved code can reach. Only the
 * assistants' own published callbacks and this computer's loopback addresses
 * are accepted, and the assistant shown on the consent page is derived from
 * that address rather than from the name a client declares for itself.
 */
const HOSTED_CALLBACKS: ReadonlyArray<{ assistant: AssistantKind; origin: string; path: RegExp }> = [
  { assistant: "claude", origin: "https://claude.ai", path: /^\/api\/mcp\/auth_callback$/u },
  { assistant: "claude", origin: "https://claude.com", path: /^\/api\/mcp\/auth_callback$/u },
  { assistant: "chatgpt", origin: "https://chatgpt.com", path: /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/u },
  { assistant: "chatgpt", origin: "https://chatgpt.com", path: /^\/connector_platform_oauth_redirect$/u },
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The web origins an assistant's own servers may present when they call the MCP endpoint. */
export const ASSISTANT_WEB_ORIGINS: ReadonlySet<string> = new Set(HOSTED_CALLBACKS.map((callback) => callback.origin));

function parsedUrl(value: string): URL | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.username || url.password || url.hash ? null : url;
  } catch {
    return null;
  }
}

/** Which assistant a redirect address belongs to, or null when Stugu will not send a code there. */
export function assistantForRedirectUri(value: string): AssistantKind | null {
  const url = parsedUrl(value);
  if (!url) return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return "local";
  if (url.search) return null;
  return HOSTED_CALLBACKS.find((callback) => callback.origin === url.origin && callback.path.test(url.pathname))?.assistant ?? null;
}

/** The one assistant every redirect address of a registration belongs to, or null when they disagree or any is refused. */
export function assistantForRedirectUris(values: readonly string[]): AssistantKind | null {
  const assistants = new Set(values.map(assistantForRedirectUri));
  if (assistants.size !== 1 || assistants.has(null)) return null;
  return [...assistants][0] ?? null;
}

/**
 * RFC 8252 lets a native app pick any loopback port at authorization time;
 * every other address must match a registered one exactly.
 */
export function redirectUriRegistered(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  const url = parsedUrl(requested);
  if (!url || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  return registered.some((candidate) => {
    const known = parsedUrl(candidate);
    return known !== null
      && known.protocol === url.protocol
      && known.hostname === url.hostname
      && known.pathname === url.pathname
      && known.search === url.search;
  });
}
