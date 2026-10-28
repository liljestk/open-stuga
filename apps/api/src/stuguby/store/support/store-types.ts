import type { StugubyInvitation, StugubyHomeCommand, StugubyHomeCommandResult, StugubyMember, StugubyMemberState, StugubyPropertyCommand, StugubyPropertyCommandResult, StugubyRole, StugubySignedEvent } from "@climate-twin/stuguby-protocol";

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
