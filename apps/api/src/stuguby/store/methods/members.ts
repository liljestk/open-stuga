import { randomUUID } from "node:crypto";
import type { StugubyInvitation, StugubyMember, StugubyMemberState, StugubyNodeIdentity, StugubyRole } from "@climate-twin/stuguby-protocol";
import { InvitationRow, MemberRow, StugubyLocalInvitation, StugubyLocalMember, JoinAdmissionRow, StugubyInvitationAdmission } from "../support/store-types.js";
import { invitationFromRow, localInvitationFromRow, localMemberFromRow, memberFromRow } from "../support/row-mappers.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    listMembers(stugubyId: string): StugubyMember[];
    listLocalMembers(stugubyId: string): StugubyLocalMember[];
    getMember(stugubyId: string, nodeId: string): StugubyMember | null;
    upsertMember(member: StugubyMember): void;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember;
    createInvitation(input: {
            stugubyId: string;
            localLabel?: string | null;
            role: Exclude<StugubyRole, "steward">;
            secretHash: string;
            expiresAt: string;
            coordinatorUrl: string;
        }): StugubyLocalInvitation;
    listInvitations(stugubyId: string): StugubyInvitation[];
    listLocalInvitations(stugubyId: string): StugubyLocalInvitation[];
    getInvitation(id: string): StugubyInvitation | null;
    admitInvitation(id: string, secretHash: string, identity: StugubyNodeIdentity, now?: string): StugubyInvitationAdmission;
    markInvitationProvisioned(invitationId: string, nodeId: string, now?: string): void;
    revokeInvitation(stugubyId: string, invitationId: string): void;
  }

  interface StugubyStoreCore {
    listMembers(stugubyId: string): StugubyMember[];
    listLocalMembers(stugubyId: string): StugubyLocalMember[];
    getMember(stugubyId: string, nodeId: string): StugubyMember | null;
    upsertMember(member: StugubyMember): void;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember;
    createInvitation(input: {
            stugubyId: string;
            localLabel?: string | null;
            role: Exclude<StugubyRole, "steward">;
            secretHash: string;
            expiresAt: string;
            coordinatorUrl: string;
        }): StugubyLocalInvitation;
    listInvitations(stugubyId: string): StugubyInvitation[];
    listLocalInvitations(stugubyId: string): StugubyLocalInvitation[];
    getInvitation(id: string): StugubyInvitation | null;
    admitInvitation(id: string, secretHash: string, identity: StugubyNodeIdentity, now?: string): StugubyInvitationAdmission;
    markInvitationProvisioned(invitationId: string, nodeId: string, now?: string): void;
    revokeInvitation(stugubyId: string, invitationId: string): void;
  }
}

registerStugubyStoreMethods({
  listMembers(this: StugubyStoreInternals, stugubyId: string): StugubyMember[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
        .all(stugubyId) as unknown as MemberRow[]).map(memberFromRow);
    },
  listLocalMembers(this: StugubyStoreInternals, stugubyId: string): StugubyLocalMember[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
        .all(stugubyId) as unknown as MemberRow[]).map(localMemberFromRow);
    },
  getMember(this: StugubyStoreInternals, stugubyId: string, nodeId: string): StugubyMember | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
        .get(stugubyId, nodeId) as unknown as MemberRow | undefined;
      return row ? memberFromRow(row) : null;
    },
  upsertMember(this: StugubyStoreInternals, member: StugubyMember): void {
      const state = this[stugubyStoreState];
      state.db.prepare(`INSERT INTO stugby_members
        (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(stugby_id,node_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,
          state=excluded.state,public_key=excluded.public_key,key_fingerprint=excluded.key_fingerprint,
          joined_at=COALESCE(stugby_members.joined_at,excluded.joined_at),updated_at=excluded.updated_at`)
        .run(member.stugubyId, member.nodeId, member.displayName, member.role, member.state, member.publicKey,
          member.keyFingerprint, member.joinedAt, member.updatedAt);
      if (member.nodeId === this.localNodeId) {
        state.db.prepare(`UPDATE stugby_federations SET local_role=?,local_member_state=?,updated_at=? WHERE id=?`)
          .run(member.role, member.state, member.updatedAt, member.stugubyId);
      }
    },
  updateMember(this: StugubyStoreInternals, stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember {
      const existing = this.getMember(stugubyId, nodeId);
      if (!existing) throw new Error("Stuguby member not found");
      if (existing.role === "steward" && (role !== "steward" || state !== "active")) throw new Error("The coordinator steward cannot be demoted or revoked");
      const updated = { ...existing, role, state, updatedAt: new Date().toISOString() };
      this.upsertMember(updated);
      this.audit(stugubyId, "member.updated", this.localNodeId, nodeId, { role, state }, updated.updatedAt);
      return updated;
    },
  updateMemberLocalLabel(this: StugubyStoreInternals, stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember {
      const state = this[stugubyStoreState];
      const changed = state.db.prepare("UPDATE stugby_members SET local_label=? WHERE stugby_id=? AND node_id=?")
        .run(localLabel, stugubyId, nodeId);
      if (Number(changed.changes) !== 1) throw new Error("Stuguby member not found");
      const row = state.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
        .get(stugubyId, nodeId) as unknown as MemberRow;
      return localMemberFromRow(row);
    },
  createInvitation(this: StugubyStoreInternals, input: {
      stugubyId: string;
      localLabel?: string | null;
      role: Exclude<StugubyRole, "steward">;
      secretHash: string;
      expiresAt: string;
      coordinatorUrl: string;
    }): StugubyLocalInvitation {
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      const id = randomUUID();
      state.db.prepare(`INSERT INTO stugby_invitations
        (id,stugby_id,local_label,role,secret_hash,expires_at,created_at,coordinator_url) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, input.stugubyId, input.localLabel ?? null, input.role, input.secretHash, input.expiresAt, now, input.coordinatorUrl);
      this.audit(input.stugubyId, "invitation.created", this.localNodeId, id, { role: input.role, expiresAt: input.expiresAt }, now);
      return localInvitationFromRow(state.db.prepare("SELECT * FROM stugby_invitations WHERE id=?").get(id) as unknown as InvitationRow);
    },
  listInvitations(this: StugubyStoreInternals, stugubyId: string): StugubyInvitation[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
        .all(stugubyId) as unknown as InvitationRow[]).map(invitationFromRow);
    },
  listLocalInvitations(this: StugubyStoreInternals, stugubyId: string): StugubyLocalInvitation[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
        .all(stugubyId) as unknown as InvitationRow[]).map(localInvitationFromRow);
    },
  getInvitation(this: StugubyStoreInternals, id: string): StugubyInvitation | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE id=?")
        .get(id) as unknown as InvitationRow | undefined;
      return row ? invitationFromRow(row) : null;
    },
  admitInvitation(this: StugubyStoreInternals, id: string, secretHash: string, identity: StugubyNodeIdentity,
      now = new Date().toISOString()): StugubyInvitationAdmission {
      const state = this[stugubyStoreState];
      state.db.exec("BEGIN IMMEDIATE");
      try {
        const row = state.db.prepare(`SELECT invitation.* FROM stugby_invitations invitation
          JOIN stugby_federations federation ON federation.id=invitation.stugby_id
          WHERE invitation.id=? AND invitation.secret_hash=? AND invitation.revoked_at IS NULL
            AND federation.is_coordinator=1`)
          .get(id, secretHash) as unknown as InvitationRow | undefined;
        if (!row || (!row.used_at && row.expires_at <= now)) {
          state.db.exec("COMMIT");
          return { status: "invalid" };
        }

        const existingMember = this.getMember(row.stugby_id, identity.nodeId);
        if (row.used_at) {
          const admission = state.db.prepare("SELECT * FROM stugby_join_admissions WHERE invitation_id=?")
            .get(row.id) as unknown as JoinAdmissionRow | undefined;
          const retryMatches = admission?.stugby_id === row.stugby_id
            && admission.node_id === identity.nodeId
            && admission.public_key === identity.publicKey
            && existingMember?.publicKey === identity.publicKey
            && existingMember?.state === "active";
          state.db.exec("COMMIT");
          return retryMatches
            ? {
              status: "retry",
              invitation: invitationFromRow(row),
              member: existingMember,
              provisioned: admission.provisioned_at !== null,
            }
            : { status: "invalid" };
        }
        if (existingMember) {
          state.db.exec("COMMIT");
          return { status: "node-conflict" };
        }

        const changed = state.db.prepare(`UPDATE stugby_invitations SET used_at=?
          WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`).run(now, id, now);
        if (Number(changed.changes) !== 1) {
          state.db.exec("ROLLBACK");
          return { status: "invalid" };
        }
        const member: StugubyMember = {
          stugubyId: row.stugby_id,
          nodeId: identity.nodeId,
          displayName: identity.displayName,
          role: row.role,
          state: "active",
          publicKey: identity.publicKey,
          keyFingerprint: identity.keyFingerprint,
          joinedAt: now,
          updatedAt: now,
        };
        state.db.prepare(`INSERT INTO stugby_members
          (stugby_id,node_id,display_name,local_label,role,state,public_key,key_fingerprint,joined_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(member.stugubyId, member.nodeId, member.displayName, row.local_label, member.role, member.state,
            member.publicKey, member.keyFingerprint, member.joinedAt, member.updatedAt);
        state.db.prepare(`INSERT INTO stugby_join_admissions
          (invitation_id,stugby_id,node_id,public_key,admitted_at) VALUES (?,?,?,?,?)`)
          .run(row.id, row.stugby_id, identity.nodeId, identity.publicKey, now);
        this.audit(row.stugby_id, "member.joined", member.nodeId, member.nodeId, { role: member.role }, now);
        state.db.exec("COMMIT");
        return {
          status: "accepted",
          invitation: { ...invitationFromRow(row), usedAt: now },
          member,
          provisioned: false,
        };
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
    },
  markInvitationProvisioned(this: StugubyStoreInternals, invitationId: string, nodeId: string, now = new Date().toISOString()): void {
      this[stugubyStoreState].db.prepare(`UPDATE stugby_join_admissions SET provisioned_at=COALESCE(provisioned_at,?)
        WHERE invitation_id=? AND node_id=?`).run(now, invitationId, nodeId);
    },
  revokeInvitation(this: StugubyStoreInternals, stugubyId: string, invitationId: string): void {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND stugby_id=? AND used_at IS NULL")
        .run(now, invitationId, stugubyId);
      this.audit(stugubyId, "invitation.revoked", this.localNodeId, invitationId, {}, now);
    },
});
