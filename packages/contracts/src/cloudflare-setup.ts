/** Guided Cloudflare Tunnel and Access setup run by the host agent. */

export type CloudflareSetupMode = "remote-ui" | "stuguby-coordinator";

export type CloudflareSetupPhase =
  | "awaiting-approval"
  | "queued"
  | "provisioning"
  | "applying"
  | "verifying"
  | "complete"
  | "failed";

export interface CloudflareSetupOperation {
  id: string;
  mode: CloudflareSetupMode;
  hostname: string;
  phase: CloudflareSetupPhase;
  requestedAt: string;
  completedAt: string | null;
  detail: string | null;
}

export interface CloudflareSetupStatus {
  capability: {
    available: boolean;
    agentLastSeenAt: string | null;
    reason: "ready" | "agent-not-connected" | "not-configured" | "agent-upgrade-required";
  };
  configuration: {
    configured: boolean;
    mode: CloudflareSetupMode | null;
    hostname: string | null;
    suggestedZone: string | null;
    accountIdKnown: boolean;
    zoneIdKnown: boolean;
    oauthClientConfigured: boolean;
    runtimeTokenAvailable: boolean;
    ownerEmail: string | null;
  };
  operation: CloudflareSetupOperation | null;
}

/** GET /cloudflare/setup: the status plus whether this request may configure, and where to do it locally. */
export interface CloudflareSetupStatusResponse extends CloudflareSetupStatus {
  canConfigure: boolean;
  localConfigureUrl: string;
}

export interface CloudflareSetupStartInput {
  mode: CloudflareSetupMode;
  hostname: string;
  zone: string;
  ownerEmail: string;
  accountId?: string | null;
  zoneId?: string | null;
  oauthClientToken?: string | null;
  runtimeToken?: string | null;
}

export interface CloudflareSetupStartResult {
  operation: CloudflareSetupOperation;
  authorizationUrl: string;
}
