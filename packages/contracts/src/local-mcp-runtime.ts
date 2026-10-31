/** The in-app MCP HTTP runtime the API can start for local assistants. */

export type LocalMcpRuntimeState = "stopped" | "starting" | "running" | "stopping" | "error";

export type LocalMcpRuntimeErrorCode = "build_missing" | "start_failed" | "unexpected_exit" | "stop_failed";

export interface LocalMcpRuntimeStatus {
  state: LocalMcpRuntimeState;
  endpointPath: "/api/v1/mcp";
  pid: number | null;
  startedAt: string | null;
  toolCount: number | null;
  serverVersion: string | null;
  errorCode: LocalMcpRuntimeErrorCode | null;
  /** Whether a manual bearer token is live. Assistant connections can run the server without one. */
  accessTokenIssued: boolean;
}

export interface LocalMcpRuntimeStartResult extends LocalMcpRuntimeStatus {
  /** Returned only by the successful start request. It is never available from status. */
  accessToken: string | null;
}
