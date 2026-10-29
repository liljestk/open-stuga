import { ASSISTANT_CONNECTOR_CONSENT_PATH, ASSISTANT_CONNECTOR_RESOURCE_PATH, type AssistantKind } from "@climate-twin/contracts";
import type { TranslationKey } from "./i18n";

/** The consent page renders on its own, without loading the workspace. */
export function isAssistantConsentLocation(location: Pick<Location, "pathname">): boolean {
  return location.pathname.replace(/\/+$/u, "") === ASSISTANT_CONNECTOR_CONSENT_PATH;
}

export function assistantNameKey(assistant: AssistantKind | string): TranslationKey {
  if (assistant === "claude") return "assistantConnector.assistantClaude";
  if (assistant === "chatgpt") return "assistantConnector.assistantChatgpt";
  return "assistantConnector.assistantLocal";
}

/** The URL people paste into Claude or ChatGPT: the MCP endpoint at the address this browser reached Stugu through. */
export function assistantConnectorUrl(origin: string): string {
  return `${origin}${ASSISTANT_CONNECTOR_RESOURCE_PATH}`;
}
