import { randomBytes } from "node:crypto";
import { STUGBY_MEDIA_TYPE, type StugubyJoinRequest, type StugubyJoinResponse, type StugubyRole, type StugubySummary, type StugubyMember, type StugubyMemberState } from "@climate-twin/stuguby-protocol";
import type { StugubyLocalInvitation, StugubyLocalMember } from "../../store.js";
import { StugubyError } from "../support/service-types.js";
import { joinSigningValue, localLabel, normalizedBaseUrl, parseIso, recordValue, requiredText, sha256, validatedMember, validatedNodeIdentity, grantAudienceIncludes, grantExpired, isLoopbackHostname } from "../support/federation-validation.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    listStugubys(): StugubySummary[];
    getStuguby(id: string): StugubySummary;
    configurePublicOrigin(value: string): Promise<string>;
    verifyPublicOrigin(publicOrigin: string): Promise<void>;
    deleteStuguby(id: string): void;
    createStuguby(input: {
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }): StugubySummary;
    createInvitation(stugubyId: string, input: {
            role: Exclude<StugubyRole, "steward">;
            expiresAt?: string;
            localLabel?: unknown;
        }): StugubyLocalInvitation & {
            joinSecret: string;
            joinUrl: string;
        };
    revokeInvitation(stugubyId: string, invitationId: string): void;
    joinStuguby(input: {
            coordinatorUrl: string;
            invitationId: string;
            joinSecret: string;
        }): Promise<StugubySummary>;
    acceptJoin(request: StugubyJoinRequest): StugubyJoinResponse;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, value: unknown): StugubyLocalMember;
    requireStuguby(id: string): StugubySummary;
    requireLocalPublisher(id: string): StugubySummary;
    requireCoordinator(id: string): StugubySummary;
    requireReadyCoordinator(id: string): StugubySummary;
  }

  interface StugubyServiceCore {
    listStugubys(): StugubySummary[];
    getStuguby(id: string): StugubySummary;
    configurePublicOrigin(value: string): Promise<string>;
    deleteStuguby(id: string): void;
    createStuguby(input: {
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }): StugubySummary;
    createInvitation(stugubyId: string, input: {
            role: Exclude<StugubyRole, "steward">;
            expiresAt?: string;
            localLabel?: unknown;
        }): StugubyLocalInvitation & {
            joinSecret: string;
            joinUrl: string;
        };
    revokeInvitation(stugubyId: string, invitationId: string): void;
    joinStuguby(input: {
            coordinatorUrl: string;
            invitationId: string;
            joinSecret: string;
        }): Promise<StugubySummary>;
    acceptJoin(request: StugubyJoinRequest): StugubyJoinResponse;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, value: unknown): StugubyLocalMember;
  }
}

registerStugubyServiceMethods({
  listStugubys(this: StugubyServiceInternals): StugubySummary[] { return this.store.listStugubys(); },
  getStuguby(this: StugubyServiceInternals, id: string): StugubySummary { return this.requireStuguby(id); },
  async configurePublicOrigin(this: StugubyServiceInternals, value: string): Promise<string> {
      const state = this[stugubyServiceState];
      const publicOrigin = normalizedBaseUrl(value);
      if (state.deploymentPublicOrigin) {
        if (publicOrigin === this.publicOrigin) return publicOrigin;
        throw new StugubyError(
          409,
          "STUGBY_PUBLIC_ORIGIN_MANAGED",
          "The coordinator origin is managed by this deployment and cannot be changed in the UI",
        );
      }
      if (!state.uiPublicOriginAllowed) {
        throw new StugubyError(
          409,
          "STUGBY_COORDINATOR_PROVISIONING_REQUIRED",
          "Reopen Stugu setup and choose Create a shared Stuguby for several homes",
        );
      }
      const establishedCoordinator = this.store.listStugubys().find((stuguby) => (
        this.store.isCoordinator(stuguby.id)
        && stuguby.coordinatorUrl !== publicOrigin
        && this.store.listMembers(stuguby.id).some((member) => member.nodeId !== this.identity.nodeId)
      ));
      if (establishedCoordinator) {
        throw new StugubyError(
          409,
          "STUGBY_COORDINATOR_ORIGIN_LOCKED",
          "A Stuguby with another node already uses a different coordinator origin",
        );
      }
      if (publicOrigin === this.publicOrigin) return publicOrigin;
      await this.verifyPublicOrigin(publicOrigin);
      this.store.setNodePublicOrigin(publicOrigin);
      state.publicOrigin = publicOrigin;
      return publicOrigin;
    },
  async verifyPublicOrigin(this: StugubyServiceInternals, publicOrigin: string): Promise<void> {
      try {
        const response = await this[stugubyServiceState].fetcher(`${publicOrigin}/api/v1/stugby-protocol/join`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: "{}",
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        const body = await this.readBoundedResponse(
          response,
          8 * 1024,
          "STUGBY_ADDRESS_UNREACHABLE",
          "Stugu could not verify its secure address",
        );
        let errorCode: unknown;
        try {
          const payload = JSON.parse(Buffer.from(body).toString("utf8")) as { error?: { code?: unknown } };
          errorCode = payload.error?.code;
        } catch {
          errorCode = null;
        }
        if (
          ![400, 503].includes(response.status)
          || !["INVALID_BODY", "INVALID_INPUT", "STUGBY_PUBLIC_ORIGIN_REQUIRED"].includes(String(errorCode))
        ) {
          throw new Error(`Unexpected verification response ${response.status}`);
        }
      } catch {
        throw new StugubyError(
          422,
          "STUGBY_ADDRESS_UNREACHABLE",
          "Stugu could not reach its secure address. Check that the address opens this Stugu, then try again",
        );
      }
    },
  deleteStuguby(this: StugubyServiceInternals, id: string): void {
      const state = this[stugubyServiceState];
      const stuguby = this.requireStuguby(id);
      if (this.store.getPropertyAdoption(id)?.state === "adopted") {
        throw new StugubyError(
          409,
          "STUGBY_PROPERTY_ADOPTED",
          "Permanently disconnect the adopted Property before deleting this Stuguby",
        );
      }
      const coordinator = this.store.isCoordinator(id);
      if (!coordinator && !["left", "revoked"].includes(stuguby.localMemberState)) {
        throw new StugubyError(
          409,
          "STUGBY_MEMBERSHIP_ACTIVE",
          "Leave this Stuguby or have its coordinator revoke this node before deleting the local record",
        );
      }
      const connectedMembers = coordinator ? this.store.listMembers(id).filter((member) => (
        member.nodeId !== this.identity.nodeId && !["left", "revoked"].includes(member.state)
      )) : [];
      if (connectedMembers.length > 0) {
        throw new StugubyError(
          409,
          "STUGBY_MEMBERS_ACTIVE",
          "Mark every other Stuguby member left or revoked before deleting this Stuguby",
        );
      }
      if (this.store.listGrants(id).some((grant) => !grant.revokedAt)) {
        throw new StugubyError(
          409,
          "STUGBY_SHARING_ACTIVE",
          "Revoke every active Home sharing grant before deleting this Stuguby",
        );
      }
      if (this.store.pendingDeletionsForStuguby(id) > 0) {
        throw new StugubyError(
          409,
          "STUGBY_DELETION_PENDING",
          "Wait for every replica deletion acknowledgement before deleting this Stuguby",
        );
      }

      const outgoingStream = state.streamControllers.get(id);
      outgoingStream?.abort();
      state.streamControllers.delete(id);
      state.pullRetries.delete(id);
      for (const [key, close] of state.incomingNotificationStreams) {
        if (!key.startsWith(`${id}\n`)) continue;
        state.incomingNotificationStreams.delete(key);
        close();
      }
      if (state.deferredNotifications) {
        state.deferredNotifications = state.deferredNotifications.filter((notification) => notification.stugubyId !== id);
      }
      this.database.clearStugubyLinks(id);
      this.deleteUnreferencedBlobs(this.store.deleteStuguby(id));
    },
  createStuguby(this: StugubyServiceInternals, input: { name: string; description?: string | null; coordinatorUrl: string }): StugubySummary {
      const summary = this.store.createCoordinatedStuguby({
        name: requiredText(input.name, "Name"),
        description: typeof input.description === "string" ? input.description.trim().slice(0, 2_000) || null : null,
        coordinatorUrl: normalizedBaseUrl(input.coordinatorUrl),
      }, this.identity);
      return summary;
    },
  createInvitation(this: StugubyServiceInternals, stugubyId: string, input: {
      role: Exclude<StugubyRole, "steward">;
      expiresAt?: string;
      localLabel?: unknown;
    }): StugubyLocalInvitation & { joinSecret: string; joinUrl: string } {
      const stuguby = this.requireReadyCoordinator(stugubyId);
      if (!["property-manager", "participant", "viewer"].includes(input.role)) {
        throw new StugubyError(400, "INVALID_ROLE", "Invitation role must be property-manager, participant, or viewer");
      }
      const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : new Date(Date.now() + 7 * 86_400_000).toISOString();
      if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 30 * 86_400_000) {
        throw new StugubyError(400, "INVALID_EXPIRY", "Invitation expiry must be within the next 30 days");
      }
      const joinSecret = randomBytes(32).toString("base64url");
      const invitation = this.store.createInvitation({
        stugubyId,
        localLabel: localLabel(input.localLabel),
        role: input.role,
        secretHash: sha256(joinSecret),
        expiresAt,
        coordinatorUrl: stuguby.coordinatorUrl,
      });
      const joinUrl = `${stuguby.coordinatorUrl}/invite-bootstrap#${encodeURIComponent(invitation.id)}.${joinSecret}`;
      return { ...invitation, joinSecret, joinUrl };
    },
  revokeInvitation(this: StugubyServiceInternals, stugubyId: string, invitationId: string): void {
      this.requireCoordinator(stugubyId);
      const invitation = this.store.listInvitations(stugubyId).find((candidate) => candidate.id === invitationId);
      if (!invitation) throw new StugubyError(404, "INVITATION_NOT_FOUND", "Stuguby invitation was not found");
      if (invitation.usedAt || invitation.revokedAt) throw new StugubyError(409, "INVITATION_INACTIVE", "Only an unused active invitation can be revoked");
      this.store.revokeInvitation(stugubyId, invitationId);
    },
  async joinStuguby(this: StugubyServiceInternals, input: { coordinatorUrl: string; invitationId: string; joinSecret: string }): Promise<StugubySummary> {
      const state = this[stugubyServiceState];
      const coordinatorUrl = normalizedBaseUrl(input.coordinatorUrl);
      const unsigned: Omit<StugubyJoinRequest, "signature"> = {
        invitationId: requiredText(input.invitationId, "Invitation id", 200),
        joinSecret: requiredText(input.joinSecret, "Join secret", 500),
        identity: this.identity,
      };
      const request: StugubyJoinRequest = { ...unsigned, signature: this.keys.sign(joinSigningValue(unsigned)) };
      const response = await state.fetcher(`${coordinatorUrl}/api/v1/stugby-protocol/join`, {
        method: "POST",
        headers: { "content-type": STUGBY_MEDIA_TYPE, "accept": STUGBY_MEDIA_TYPE },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.any([state.lifecycleController.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw await this.remoteError(response, "Stuguby join failed");
      let joined: StugubyJoinResponse;
      try {
        const raw = recordValue(await this.readJsonResponse(response, 2 * 1024 * 1024, "Join response"), "Join response");
        const rawSummary = recordValue(raw.stuguby, "Joined Stuguby");
        const stugubyId = requiredText(rawSummary.id, "Stuguby id", 100);
        const coordinatorIdentity = validatedNodeIdentity(raw.coordinatorIdentity);
        const rawMembers = Array.isArray(raw.members) ? raw.members : [];
        if (!rawMembers.length || rawMembers.length > 1_000) throw new Error("Invalid member list");
        const members = rawMembers.map((member) => validatedMember(member, stugubyId));
        if (new Set(members.map((member) => member.nodeId)).size !== members.length) throw new Error("Duplicate member identity");
        const coordinatorNodeId = requiredText(rawSummary.coordinatorNodeId, "Coordinator node id", 100);
        const coordinatorMember = members.find((member) => member.nodeId === coordinatorNodeId);
        if (coordinatorIdentity.nodeId !== coordinatorNodeId || !coordinatorMember
          || coordinatorMember.role !== "steward" || coordinatorMember.state !== "active"
          || coordinatorMember.publicKey !== coordinatorIdentity.publicKey) throw new Error("Invalid coordinator identity");
        const local = members.find((member) => member.nodeId === this.identity.nodeId);
        if (!local || local.state !== "active" || local.publicKey !== this.identity.publicKey) throw new Error("Local membership missing");
        const createdAt = parseIso(requiredText(rawSummary.createdAt, "createdAt", 100), "createdAt");
        const updatedAt = parseIso(requiredText(rawSummary.updatedAt, "updatedAt", 100), "updatedAt");
        joined = {
          stuguby: {
            id: stugubyId,
            name: requiredText(rawSummary.name, "Stuguby name"),
            description: rawSummary.description === null ? null : requiredText(rawSummary.description, "Stuguby description", 2_000),
            coordinatorNodeId,
            coordinatorUrl,
            localRole: local.role,
            localMemberState: local.state,
            memberCount: members.filter((member) => member.state === "active").length,
            createdAt,
            updatedAt,
            lastSyncAt: null,
            lastSyncError: null,
          },
          member: local,
          members,
          coordinatorIdentity,
          cursor: 0,
        };
      } catch (error) {
        throw new StugubyError(502, "INVALID_JOIN_RESPONSE", error instanceof Error ? `Coordinator returned an invalid join response: ${error.message}` : "Coordinator returned an invalid join response");
      }
      const existingStuguby = this.store.getStuguby(joined.stuguby.id);
      if (existingStuguby) {
        const existingMember = this.store.getMember(joined.stuguby.id, this.identity.nodeId);
        if (existingStuguby.coordinatorUrl === coordinatorUrl
          && existingStuguby.coordinatorNodeId === joined.stuguby.coordinatorNodeId
          && existingMember?.publicKey === this.identity.publicKey
          && existingMember?.state === "active") {
          return existingStuguby;
        }
        throw new StugubyError(409, "STUGBY_ALREADY_EXISTS", "This Stugu has already joined a different Stuguby record with that id");
      }
      const local = joined.member;
      const saved = this.store.saveJoinedStuguby(joined.stuguby, joined.members, local);
      if (state.started) this.ensureNotificationStreams();
      return saved;
    },
  acceptJoin(this: StugubyServiceInternals, request: StugubyJoinRequest): StugubyJoinResponse {
      const raw = recordValue(request, "Join request");
      const normalized: StugubyJoinRequest = {
        invitationId: requiredText(raw.invitationId, "Invitation id", 200),
        joinSecret: requiredText(raw.joinSecret, "Join secret", 500),
        identity: validatedNodeIdentity(raw.identity),
        signature: requiredText(raw.signature, "Join signature", 512),
      };
      if (!this.keys.verify(joinSigningValue(normalized), normalized.signature, normalized.identity.publicKey)) {
        throw new StugubyError(401, "INVALID_JOIN_PROOF", "Join request proof is invalid");
      }
      const pendingInvitation = this.store.getInvitation(normalized.invitationId);
      if (pendingInvitation) this.requireReadyCoordinator(pendingInvitation.stugubyId);
      const secretHash = sha256(normalized.joinSecret);
      const admission = this.store.admitInvitation(normalized.invitationId, secretHash, normalized.identity);
      if (admission.status === "invalid") {
        throw new StugubyError(401, "INVALID_INVITATION", "Invitation is invalid, expired, revoked, used by another node, or otherwise inactive");
      }
      if (admission.status === "node-conflict") {
        throw new StugubyError(409, "NODE_ALREADY_MEMBER", "That node identity is already registered in this Stuguby");
      }
      const stuguby = this.requireReadyCoordinator(admission.invitation.stugubyId);
      const member = admission.member;
      if (!admission.provisioned) {
        this.publishMember(member);
        for (const existing of this.store.listMembers(stuguby.id)) this.sendMemberSnapshot(existing, member.nodeId);
        const property = this.store.getSharedProperty(stuguby.id);
        if (property) this.sendSharedPropertySnapshot(property, member.nodeId);
        for (const grant of this.store.listGrants(stuguby.id, this.identity.nodeId)) {
          if (grant.audience.kind !== "all-members" || grant.revokedAt || grantExpired(grant)) continue;
          const house = this.database.getHouse(grant.localHouseId ?? "");
          if (house) {
            this.publishGrant(grant, "grant.upserted");
            this.publishGrantSnapshots(grant, house);
          }
        }
        this.store.markInvitationProvisioned(admission.invitation.id, member.nodeId);
      }
      const participantSummary: StugubySummary = {
        ...this.store.getStuguby(stuguby.id)!,
        localRole: member.role,
        localMemberState: member.state,
      };
      return {
        stuguby: participantSummary,
        member,
        members: this.store.listMembers(stuguby.id),
        coordinatorIdentity: this.identity,
        cursor: 0,
      };
    },
  updateMember(this: StugubyServiceInternals, stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember {
      const stuguby = this.requireCoordinator(stugubyId);
      if (!(["steward", "property-manager", "participant", "viewer"] as string[]).includes(role)
        || !(["active", "suspended", "left", "revoked"] as string[]).includes(state)) {
        throw new StugubyError(400, "INVALID_MEMBERSHIP", "Invalid Stuguby role or membership state");
      }
      const existingMember = this.store.getMember(stugubyId, nodeId);
      if (!existingMember) throw new StugubyError(404, "MEMBER_NOT_FOUND", "Stuguby member was not found");
      if (role === "steward" && nodeId !== stuguby.coordinatorNodeId) throw new StugubyError(400, "INVALID_STEWARD", "Only the coordinator node can hold the steward role");
      if (nodeId === stuguby.coordinatorNodeId && (role !== "steward" || state !== "active")) {
        throw new StugubyError(409, "COORDINATOR_REQUIRED", "The coordinator steward cannot be demoted or deactivated");
      }
      // Expiry stops new reads immediately, but an unretired expired grant still
      // needs its tombstone/deletion handshake before either endpoint can leave.
      const activeGrants = this.store.listGrants(stugubyId).filter((grant) => !grant.revokedAt
          && (grant.authorityNodeId === nodeId || grantAudienceIncludes(grant, nodeId)));
      if (state !== "active") {
        if (activeGrants.length > 0) {
          throw new StugubyError(409, "MEMBER_DATA_STILL_SHARED", "Revoke or narrow every grant involving this node before deactivating its membership");
        }
        if (this.store.pendingDeletions(stugubyId, nodeId) > 0) {
          throw new StugubyError(409, "DELETION_ACK_PENDING", "Wait for this node to synchronize and acknowledge deletion before deactivating it");
        }
      }
      if (role === "viewer" && activeGrants.some((grant) => grant.authorityNodeId === nodeId)) {
        throw new StugubyError(409, "PUBLISHER_GRANT_ACTIVE", "Revoke this node's active Home grants before changing it to the read-only viewer role");
      }
      return this.atomicPublication(() => {
        const updated = this.store.updateMember(stugubyId, nodeId, role, state);
        this.publishMember(updated);
        if (updated.state === "active" && existingMember.state !== "active" && updated.nodeId !== this.identity.nodeId) {
          const property = this.store.getSharedProperty(stugubyId);
          if (property) this.sendSharedPropertySnapshot(property, updated.nodeId);
          for (const grant of this.store.listGrants(stugubyId, this.identity.nodeId)) {
            if (grant.audience.kind !== "all-members" || grant.revokedAt || grantExpired(grant)) continue;
            const house = this.database.getHouse(grant.localHouseId ?? "");
            if (!house) throw new StugubyError(409, "GRANT_HOUSE_MISSING", "An active all-member grant references a missing local Home");
            this.publishGrant(grant, "grant.upserted");
            this.publishGrantSnapshots(grant, house);
          }
        }
        return updated;
      });
    },
  updateMemberLocalLabel(this: StugubyServiceInternals, stugubyId: string, nodeId: string, value: unknown): StugubyLocalMember {
      this.requireStuguby(stugubyId);
      if (!this.store.getMember(stugubyId, nodeId)) {
        throw new StugubyError(404, "MEMBER_NOT_FOUND", "Stuguby member was not found");
      }
      return this.store.updateMemberLocalLabel(stugubyId, nodeId, localLabel(value));
    },
  requireStuguby(this: StugubyServiceInternals, id: string): StugubySummary {
      const stuguby = this.store.getStuguby(id);
      if (!stuguby) throw new StugubyError(404, "STUGBY_NOT_FOUND", "Stuguby was not found");
      return stuguby;
    },
  requireLocalPublisher(this: StugubyServiceInternals, id: string): StugubySummary {
      const stuguby = this.requireStuguby(id);
      const member = this.store.getMember(id, this.identity.nodeId);
      if (!member || member.publicKey !== this.identity.publicKey) {
        throw new StugubyError(
          409,
          "STUGBY_IDENTITY_MISMATCH",
          "This Stugu's saved identity does not match its Stuguby membership. Restore the original identity before sharing or synchronizing.",
        );
      }
      if (stuguby.localMemberState !== "active" || stuguby.localRole === "viewer") {
        throw new StugubyError(403, "PUBLISHING_FORBIDDEN", "An active steward, property manager, or participant node is required to publish Home data");
      }
      if (member.state !== stuguby.localMemberState || member.role !== stuguby.localRole) {
        throw new StugubyError(409, "STUGBY_MEMBERSHIP_MISMATCH", "The local Stuguby membership summary is out of date. Synchronize before publishing Home data.");
      }
      return stuguby;
    },
  requireCoordinator(this: StugubyServiceInternals, id: string): StugubySummary {
      const stuguby = this.requireLocalPublisher(id);
      const member = this.store.getMember(id, this.identity.nodeId);
      if (!this.store.isCoordinator(id) || stuguby.coordinatorNodeId !== this.identity.nodeId || member?.role !== "steward") {
        throw new StugubyError(409, "COORDINATOR_REQUIRED", "This operation must be performed by the Stuguby coordinator");
      }
      return stuguby;
    },
  requireReadyCoordinator(this: StugubyServiceInternals, id: string): StugubySummary {
      const stuguby = this.requireCoordinator(id);
      const loopback = (() => {
        try { return isLoopbackHostname(new URL(stuguby.coordinatorUrl).hostname); } catch { return false; }
      })();
      if ((this.publicOrigin && stuguby.coordinatorUrl !== this.publicOrigin) || (!this.publicOrigin && !loopback)) {
        throw new StugubyError(
          503,
          "STUGBY_COORDINATOR_ORIGIN_MISMATCH",
          "The stored Stuguby coordinator URL does not match this server's configured public origin",
        );
      }
      return stuguby;
    },
});
