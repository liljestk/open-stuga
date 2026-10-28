import type { StugubyInvitation, StugubyMember, StugubySignedEvent } from "@climate-twin/stuguby-protocol";
import type { InvitationRow, MemberRow, StugubyLocalInvitation, StugubyLocalMember } from "./store-types.js";

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
