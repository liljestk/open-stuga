import type { AssistantAuthorizationInput } from "@climate-twin/contracts";
import { request } from "./support/request";
import { assistantAuthorizationPreviewShape, assistantAuthorizationRedirectShape, assistantConnectionShape } from "./support/entity-shapes";
import { arrayOf, fields } from "./support/response-shapes";

const assistantConnectionsShape = fields({ connections: arrayOf(assistantConnectionShape) });

/** Assistant connections: the consent page's request preview and decision, and the Owner/Admin connection list. */
export const assistantConnectorApi = {
  /** `query` is the OAuth authorization query the consent page was opened with, passed through unchanged. */
  assistantAuthorizationPreview: (query: string) => request(
    `/assistant-connector/authorization?${query}`,
    assistantAuthorizationPreviewShape,
  ),
  decideAssistantAuthorization: (input: AssistantAuthorizationInput) => request(
    "/assistant-connector/authorization",
    assistantAuthorizationRedirectShape,
    { method: "POST", body: JSON.stringify(input) },
  ),
  assistantConnections: async () => (await request("/assistant-connector/connections", assistantConnectionsShape)).connections,
  revokeAssistantConnection: async (id: string) => (await request(
    `/assistant-connector/connections/${encodeURIComponent(id)}`,
    assistantConnectionsShape,
    { method: "DELETE" },
  )).connections,
};
