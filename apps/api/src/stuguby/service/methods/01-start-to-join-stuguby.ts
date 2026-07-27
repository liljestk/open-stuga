import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AreaEquipment,
  Floor,
  House,
  MaintenanceTask,
  MeasurementSample,
  Property,
  PropertyArea,
  PropertyAreaKind,
  PropertyNote,
  Sensor,
  StugubyHouseLink,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  STUGBY_MAX_BATCH_EVENTS,
  STUGBY_MAX_BLOB_BYTES,
  STUGBY_MAX_CLOCK_SKEW_SECONDS,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  canonicalJson,
  eventSigningValue,
  isStugubyDataset,
  isStugubyRole,
  requestSigningValue,
  validateDatasetPayload,
  validateHomeCommand,
  validateHomeCommandResult,
  validatePropertyCommand,
  validatePropertyCommandResult,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type JsonObject,
  type JsonValue,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyDeletionReceipt,
  type StugubyBlobMediaType,
  type StugubyBlobReference,
  type StugubyEventBatch,
  type StugubyEventPage,
  type StugubyGrantAudience,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyHomeCommandSnapshot,
  type StugubyHomeDirectoryPayload,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeLocationPayload,
  type StugubyHomeNotesPayload,
  type StugubyHomeObservationsPayload,
  type StugubyHomeRecoveryKind,
  type StugubyHomeRecoveryPayload,
  type StugubyHomeStructurePayload,
  type StugubyInvitation,
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRole,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import type { TelemetryBus } from "../../../events.js";
import type { StugubyNodeKeys } from "../../identity.js";
import { publicKeyFingerprint } from "../../identity.js";
import { durableAtomicWriteFileSync } from "../../durable-write.js";
import {
  StugubyStore,
  type StugubyAuthorityTransfer,
  type StugubyHomeProjection,
  type StugubyLocalInvitation,
  type StugubyLocalMember,
  type StugubyOutboxItem,
  type StugubyPropertyAdoption,
} from "../../store.js";
import { StugubyError, joinSigningValue, localLabel, normalizedBaseUrl, parseIso, recordValue, requiredText, sha256, validatedMember, validatedNodeIdentity } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  start(this: StugubyServiceInternals): void {
      if (this[stugubyServiceState].lifecycleController.signal.aborted) this[stugubyServiceState].lifecycleController = new AbortController();
      this[stugubyServiceState].started = true;
      if (!this[stugubyServiceState].removeMeasurementListener) {
        this[stugubyServiceState].removeMeasurementListener = this[stugubyServiceState].bus.subscribeMeasurements((sample) => this.publishLiveTelemetry(sample));
      }
      if (!this[stugubyServiceState].timer) {
        this[stugubyServiceState].timer = setInterval(() => { void this.syncAll().catch(() => undefined); }, this[stugubyServiceState].syncIntervalMs);
        this[stugubyServiceState].timer.unref();
      }
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
      this.ensureNotificationStreams();
      void this.syncAll().catch(() => undefined);
    },
  async stop(this: StugubyServiceInternals): Promise<void> {
      this[stugubyServiceState].started = false;
      if (this[stugubyServiceState].timer) clearInterval(this[stugubyServiceState].timer);
      this[stugubyServiceState].timer = null;
      this[stugubyServiceState].removeMeasurementListener?.();
      this[stugubyServiceState].removeMeasurementListener = null;
      this[stugubyServiceState].lifecycleController.abort(new Error("Stuguby service is stopping"));
      for (const controller of this[stugubyServiceState].streamControllers.values()) controller.abort();
      this[stugubyServiceState].streamControllers.clear();
      for (const close of this[stugubyServiceState].incomingNotificationStreams.values()) close();
      this[stugubyServiceState].incomingNotificationStreams.clear();
      await Promise.allSettled([...this[stugubyServiceState].streamTasks.values()]);
      await Promise.allSettled([...this[stugubyServiceState].activeSyncs]);
    },
  trackSync<T>(this: StugubyServiceInternals, operation: Promise<T>): Promise<T> {
      this[stugubyServiceState].activeSyncs.add(operation);
      void operation.then(
        () => { this[stugubyServiceState].activeSyncs.delete(operation); },
        () => { this[stugubyServiceState].activeSyncs.delete(operation); },
      );
      return operation;
    },
  listStugubys(this: StugubyServiceInternals): StugubySummary[] { return this.store.listStugubys(); },
  getStuguby(this: StugubyServiceInternals, id: string): StugubySummary { return this.requireStuguby(id); },
  async configurePublicOrigin(this: StugubyServiceInternals, value: string): Promise<string> {
      const publicOrigin = normalizedBaseUrl(value);
      if (this[stugubyServiceState].deploymentPublicOrigin) {
        if (publicOrigin === this.publicOrigin) return publicOrigin;
        throw new StugubyError(
          409,
          "STUGBY_PUBLIC_ORIGIN_MANAGED",
          "The coordinator origin is managed by this deployment and cannot be changed in the UI",
        );
      }
      if (!this[stugubyServiceState].uiPublicOriginAllowed) {
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
      this[stugubyServiceState].publicOrigin = publicOrigin;
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

      const outgoingStream = this[stugubyServiceState].streamControllers.get(id);
      outgoingStream?.abort();
      this[stugubyServiceState].streamControllers.delete(id);
      for (const [key, close] of this[stugubyServiceState].incomingNotificationStreams) {
        if (!key.startsWith(`${id}\n`)) continue;
        this[stugubyServiceState].incomingNotificationStreams.delete(key);
        close();
      }
      if (this[stugubyServiceState].deferredNotifications) {
        this[stugubyServiceState].deferredNotifications = this[stugubyServiceState].deferredNotifications.filter((notification) => notification.stugubyId !== id);
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
  assertGrantScope(this: StugubyServiceInternals, stugubyId: string, grantId: string): void {
      const grant = this.store.getGrant(grantId);
      if (!grant || grant.stugubyId !== stugubyId) throw new StugubyError(404, "GRANT_NOT_FOUND", "Share grant was not found in this Stuguby");
    },
  async joinStuguby(this: StugubyServiceInternals, input: { coordinatorUrl: string; invitationId: string; joinSecret: string }): Promise<StugubySummary> {
      const coordinatorUrl = normalizedBaseUrl(input.coordinatorUrl);
      const unsigned: Omit<StugubyJoinRequest, "signature"> = {
        invitationId: requiredText(input.invitationId, "Invitation id", 200),
        joinSecret: requiredText(input.joinSecret, "Join secret", 500),
        identity: this.identity,
      };
      const request: StugubyJoinRequest = { ...unsigned, signature: this.keys.sign(joinSigningValue(unsigned)) };
      const response = await this[stugubyServiceState].fetcher(`${coordinatorUrl}/api/v1/stugby-protocol/join`, {
        method: "POST",
        headers: { "content-type": STUGBY_MEDIA_TYPE, "accept": STUGBY_MEDIA_TYPE },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.any([this[stugubyServiceState].lifecycleController.signal, AbortSignal.timeout(30_000)]),
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
      if (this[stugubyServiceState].started) this.ensureNotificationStreams();
      return saved;
    },
});
