/** OAuth-connected AI assistants (Claude, ChatGPT, local MCP apps) reading Stugu over MCP. */

/** The single, read-only permission an assistant connection grants. */
export const ASSISTANT_CONNECTOR_SCOPE = "stugu.read";

/** Where the MCP endpoint lives below the public origin; the protected resource every grant is bound to. */
export const ASSISTANT_CONNECTOR_RESOURCE_PATH = "/api/v1/mcp";

/** The browser page that asks an Owner or Admin to approve a connection; OAuth's authorization endpoint. */
export const ASSISTANT_CONNECTOR_CONSENT_PATH = "/connect/assistant";

export const ASSISTANT_KINDS = ["claude", "chatgpt", "local"] as const;

/** Which assistant a connection belongs to, derived from its registered redirect address, never from its self-declared name. */
export type AssistantKind = (typeof ASSISTANT_KINDS)[number];

export type AssistantAuthorizationDecision = "approve" | "deny";

/** The consent page sends back the exact OAuth query it was opened with, plus the person's decision. */
export interface AssistantAuthorizationInput {
  query: string;
  decision: AssistantAuthorizationDecision;
}

/** What the consent page shows before the person decides. */
export interface AssistantAuthorizationPreview {
  assistant: AssistantKind;
  clientName: string | null;
  redirectOrigin: string;
  scope: string;
}

/** Where the browser goes next: the assistant's callback carrying a code, or an access_denied error. */
export interface AssistantAuthorizationRedirect {
  redirectUrl: string;
}

export interface AssistantConnection {
  id: string;
  assistant: AssistantKind;
  clientName: string | null;
  approvedBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AssistantConnectionsResponse {
  connections: AssistantConnection[];
}

export function isAssistantKind(value: unknown): value is AssistantKind {
  return typeof value === "string" && (ASSISTANT_KINDS as readonly string[]).includes(value);
}
