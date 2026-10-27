import {
  type StugubyInvitation,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyRole,
  type StugubySignedEvent,
} from "@climate-twin/stuguby-protocol";

export interface StugubyRow {
  id: string;
  name: string;
  description: string | null;
  coordinator_node_id: string;
  coordinator_url: string;
  local_role: StugubyRole;
  local_member_state: StugubyMemberState;
  is_coordinator: number;
  created_at: string;
  updated_at: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
  pull_cursor: number;
}

export interface MemberRow {
  stugby_id: string;
  node_id: string;
  display_name: string;
  local_label: string | null;
  role: StugubyRole;
  state: StugubyMemberState;
  public_key: string;
  key_fingerprint: string;
  joined_at: string | null;
  updated_at: string;
}

export interface InvitationRow {
  id: string;
  stugby_id: string;
  local_label: string | null;
  role: Exclude<StugubyRole, "steward">;
  secret_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  revoked_at: string | null;
  coordinator_url: string;
}

export interface JoinAdmissionRow {
  invitation_id: string;
  stugby_id: string;
  node_id: string;
  public_key: string;
  admitted_at: string;
  provisioned_at: string | null;
}

export interface GrantRow { grant_json: string }

export interface SharedPropertyRow { property_json: string }

export interface OutboxRow {
  id: number;
  stugby_id: string;
  destination_node_id: string;
  event_json: string;
  attempts: number;
}

export interface StugubyOutboxItem {
  id: number;
  stugubyId: string;
  destinationNodeId: string;
  event: StugubySignedEvent;
  attempts: number;
}

export interface StugubyLocalMember extends StugubyMember {
  /** Private to this Stugu installation and never included in federation events. */
  localLabel: string | null;
}

export interface StugubyLocalInvitation extends StugubyInvitation {
  /** Private to the coordinator and copied to its local member roster on admission. */
  localLabel: string | null;
}

export interface StugubyEventLogPage {
  events: StugubySignedEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface StugubyStoredPropertyCommand {
  command: StugubyPropertyCommand;
  status: "pending" | "applied" | "conflict" | "cancelled";
  result: StugubyPropertyCommandResult | null;
  attempts: number;
  nextAttemptAt: string;
  updatedAt: string;
}

export interface StugubyStoredHomeCommand {
  command: StugubyHomeCommand;
  status: "pending" | "applied" | "conflict" | "cancelled";
  result: StugubyHomeCommandResult | null;
  attempts: number;
  nextAttemptAt: string;
  updatedAt: string;
}

export type ProjectionResourceType =
  | "area" | "equipment" | "note" | "maintenance"
  | "home" | "floor" | "room" | "wall" | "plan-element" | "sensor"
  | "home-note" | "observation" | "asset";

export type PublicationResourceType =
  | "home" | "floor" | "room" | "wall" | "plan-element" | "sensor" | "note" | "observation";

export type StugubyInvitationAdmission =
  | {
    status: "accepted";
    invitation: StugubyInvitation;
    member: StugubyMember;
    provisioned: boolean;
  }
  | {
    status: "retry";
    invitation: StugubyInvitation;
    member: StugubyMember;
    provisioned: boolean;
  }
  | { status: "invalid" }
  | { status: "node-conflict" };

export type StugubyDeletionReceiptResult = "accepted" | "retry" | "conflict" | "unexpected";

export interface RemoteTelemetryQuery {
  stugubyId: string;
  authorityNodeId?: string;
  publicationId?: string;
  sensorPublicationId?: string;
  metricId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function memberFromRow(row: MemberRow): StugubyMember {
  return {
    stugubyId: row.stugby_id,
    nodeId: row.node_id,
    displayName: row.display_name,
    role: row.role,
    state: row.state,
    publicKey: row.public_key,
    keyFingerprint: row.key_fingerprint,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

export function localMemberFromRow(row: MemberRow): StugubyLocalMember {
  return { ...memberFromRow(row), localLabel: row.local_label };
}

export function invitationFromRow(row: InvitationRow): StugubyInvitation {
  return {
    id: row.id,
    stugubyId: row.stugby_id,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    coordinatorUrl: row.coordinator_url,
  };
}

export function localInvitationFromRow(row: InvitationRow): StugubyLocalInvitation {
  return { ...invitationFromRow(row), localLabel: row.local_label };
}

export function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback;
}

export function resourceBlobDigests(schemaName: string, payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  if (schemaName === "home.floorplan.v1") {
    if (!Array.isArray(value.assets)) return [];
    return value.assets.flatMap((asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
      const image = (asset as Record<string, unknown>).image;
      if (!image || typeof image !== "object" || Array.isArray(image)) return [];
      const digest = (image as Record<string, unknown>).digest;
      return typeof digest === "string" ? [digest] : [];
    });
  }
  if (schemaName === "home.recovery.v1" && value.kind === "assets") {
    if (!Array.isArray(value.records)) return [];
    return value.records.flatMap((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return [];
      const digest = (record as Record<string, unknown>).digest;
      return typeof digest === "string" ? [digest] : [];
    });
  }
  return [];
}

export function eventBlobDigests(event: StugubySignedEvent): string[] {
  return event.operation === "upsert" ? resourceBlobDigests(event.schema, event.payload) : [];
}
