import type { Property, StugubyHouseLink, StugubyPropertyAdoption } from "@climate-twin/contracts";
import {
  assertSafeFederationPayload,
  validateSharedProperty,
  type JsonValue,
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import { type StugubyLocalMember } from "../../store.js";
import { SharedPropertyInput, StugubyError, grantAudienceIncludes, grantExpired, joinSigningValue, localLabel, recordValue, requiredText, sha256, validatedNodeIdentity } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
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
  async updateSharedProperty(this: StugubyServiceInternals, stugubyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugubySharedProperty> {
      const stuguby = this.requireStuguby(stugubyId);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new StugubyError(400, "INVALID_REVISION", "baseRevision must be a positive integer");
      if (!this.store.isCoordinator(stugubyId)) {
        if (stuguby.localRole !== "property-manager") throw new StugubyError(403, "PROPERTY_WRITE_FORBIDDEN", "Only a Stuguby steward or property manager may edit shared property data");
        const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/property`, {
          method: "PUT",
          body: JSON.stringify({ baseRevision, property: input }),
        });
        if (!response.ok) throw await this.remoteError(response, "Shared property update failed");
        const property = validateSharedProperty(await this.readJsonResponse(response, 2 * 1024 * 1024, "Shared property response"));
        this.store.saveSharedProperty(property);
        this.materializeSharedProperty(property);
        return property;
      }
      return this.updateSharedPropertyAs(this.identity.nodeId, stugubyId, baseRevision, input);
    },
  updateSharedPropertyAs(this: StugubyServiceInternals, actorNodeId: string, stugubyId: string, baseRevision: number, input: SharedPropertyInput): StugubySharedProperty {
      this.requireCoordinator(stugubyId);
      const actor = this.store.getMember(stugubyId, actorNodeId);
      const existing = this.store.getSharedProperty(stugubyId);
      if (!actor || actor.state !== "active" || actor.role === "viewer"
        || (actorNodeId !== this.identity.nodeId && existing?.editPolicy === "read-only")) {
        throw new StugubyError(403, "PROPERTY_WRITE_FORBIDDEN", existing?.editPolicy === "read-only"
          ? "The coordinator has shared this Property as read-only"
          : "Only an active Stuguby member with editing access may edit shared Property data");
      }
      const designatedSuccessorNodeId = input.designatedSuccessorNodeId === undefined
        ? existing?.designatedSuccessorNodeId ?? null
        : input.designatedSuccessorNodeId;
      if (designatedSuccessorNodeId) {
        const successor = this.store.getMember(stugubyId, designatedSuccessorNodeId);
        if (!successor || successor.state !== "active" || successor.nodeId === this.identity.nodeId) {
          throw new StugubyError(400, "INVALID_SUCCESSOR", "The designated Property successor must be one active remote member");
        }
      }
      assertSafeFederationPayload(input);
      const now = new Date().toISOString();
      const property: StugubySharedProperty = {
        ...input,
        stugubyId,
        name: requiredText(input.name, "Property name"),
        editPolicy: input.editPolicy ?? existing?.editPolicy ?? "collaborative",
        authorityEpoch: existing?.authorityEpoch ?? 1,
        designatedSuccessorNodeId,
        revision: baseRevision + 1,
        updatedAt: now,
      };
      validateSharedProperty(property);
      const updated = this.atomicPublication(() => {
        try { this.store.saveSharedProperty(property, baseRevision); } catch (error) {
          throw new StugubyError(409, "REVISION_CONFLICT", error instanceof Error ? error.message : "Shared property revision conflict");
        }
        this.store.setPropertyFieldRevisions(stugubyId, "property", stugubyId, ["name", "description", "location"], property.revision);
        for (const [kind, values] of [
          ["area", property.areas],
          ["equipment", property.equipment],
          ["note", property.notes],
          ["maintenance", property.maintenance],
        ] as const) {
          for (const value of values) {
            this.store.setPropertyFieldRevisions(stugubyId, kind, value.id,
              Object.keys(value).filter((field) => field !== "id"), property.revision);
          }
        }
        this.store.audit(stugubyId, "shared-property.updated", actorNodeId, stugubyId, { revision: property.revision }, now);
        this.publishSharedPropertyEvent(property);
        return property;
      });
      this.materializeSharedProperty(updated);
      return updated;
    },
  adoptProperty(this: StugubyServiceInternals, stugubyId: string, localPropertyId?: string): StugubyPropertyAdoption {
      const stuguby = this.requireStuguby(stugubyId);
      if (stuguby.localMemberState !== "active") {
        throw new StugubyError(409, "STUGBY_NOT_ACTIVE", "Reconnect this Stuguby membership before adopting its Property");
      }
      const existingAdoption = this.store.getPropertyAdoption(stugubyId);
      if (existingAdoption?.state === "adopted") return existingAdoption;
      const shared = this.store.getSharedProperty(stugubyId);
      if (!shared) throw new StugubyError(409, "SHARED_PROPERTY_NOT_READY", "Synchronize the Stuguby Property before adopting it");

      return this.atomicPublication(() => {
        let target: Property;
        if (localPropertyId) {
          if (!this.store.isCoordinator(stugubyId)) {
            throw new StugubyError(400, "MIGRATION_REQUIRED", "A Client uses the Host Property first, then moves its local Property into it");
          }
          const local = this.database.getProperty(localPropertyId);
          if (!local) throw new StugubyError(404, "PROPERTY_NOT_FOUND", "The local Property was not found");
          if (local.stuguby && local.stuguby.syncState !== "detached" && local.stuguby.stugubyId !== stugubyId) {
            throw new StugubyError(409, "PROPERTY_ALREADY_SHARED", "That Property already belongs to another Stuguby");
          }
          this.store.releaseDetachedProperty(local.id, stugubyId);
          for (const house of this.database.listHouses(local.id)) {
            if (house.stuguby?.syncState === "detached") this.database.setHouseStugubyLink(house.id, null);
          }
          target = local;
          this.registerLocalPropertyMappings(stuguby, target.id);
          const seeded = this.sharedPropertyFromLocal(stugubyId, target.id, shared);
          this.updateSharedPropertyAs(this.identity.nodeId, stugubyId, shared.revision, seeded);
        } else {
          target = this.database.createProperty({
            name: shared.name,
            description: shared.description,
            location: shared.location ? { ...shared.location, source: "manual" } : null,
          });
        }

        const current = this.store.getSharedProperty(stugubyId)!;
        const adoption = this.store.adoptProperty(stugubyId, target.id, current.revision);
        this.materializeSharedProperty(current);
        this.materializeAllRemoteHomes(stugubyId);
        if (this.store.isCoordinator(stugubyId)) {
          for (const house of this.database.listHouses(target.id)) {
            if (!house.stuguby || house.stuguby.ownership === "local") this.markLocalHouseInAdoptedProperty(house.id);
          }
        }
        this.store.audit(stugubyId, "property.adopted", this.identity.nodeId, target.id, {
          revision: current.revision,
          coordinatorOwned: this.store.isCoordinator(stugubyId),
        });
        return adoption;
      });
    },
  migrateProperty(this: StugubyServiceInternals, stugubyId: string, sourcePropertyId: string): {
      adoption: StugubyPropertyAdoption;
      migrationSnapshotId: string;
      moved: ReturnType<ClimateDatabase["migratePropertyInto"]>;
      createdGrants: StugubyShareGrant[];
    } {
      const stuguby = this.requireStuguby(stugubyId);
      if (this.store.isCoordinator(stugubyId)) {
        throw new StugubyError(
          409,
          "HOST_PROPERTY_MIGRATION_NOT_ALLOWED",
          "The Host selects the shared Property directly. Moving a local Property into it is available only on Clients",
        );
      }
      this.requireLocalPublisher(stugubyId);
      const adoption = this.store.getPropertyAdoption(stugubyId);
      if (!adoption || adoption.state !== "adopted") {
        throw new StugubyError(409, "PROPERTY_NOT_ADOPTED", "Use the Host Property before moving a local Property into it");
      }
      const source = this.database.getProperty(requiredText(sourcePropertyId, "Source Property id"));
      if (!source) throw new StugubyError(404, "PROPERTY_NOT_FOUND", "The local Property was not found");
      if (source.id === adoption.localPropertyId) throw new StugubyError(409, "PROPERTY_MIGRATION_SAME_TARGET", "The selected Property is already adopted");
      if (source.stuguby && source.stuguby.syncState !== "detached") {
        throw new StugubyError(409, "PROPERTY_ALREADY_SHARED", "A shared Property cannot be migrated into another shared Property");
      }

      return this.atomicPublication(() => {
        this.store.releaseDetachedProperty(source.id, stugubyId);
        const houses = this.database.listHouses(source.id);
        const areas = this.database.listPropertyAreas(source.id);
        const equipment = this.database.listAreaEquipment({ propertyId: source.id });
        const notes = this.database.listPropertyNotes({ propertyId: source.id });
        const maintenance = this.database.listMaintenanceTasks({ propertyId: source.id });
        const snapshot = {
          property: source,
          houses,
          areas,
          equipment,
          notes,
          maintenance,
        } as unknown as JsonValue;
        const migrationSnapshotId = this.store.saveMigrationSnapshot(
          stugubyId,
          source.id,
          adoption.localPropertyId,
          snapshot,
        );

        for (const area of areas) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "area", area.id, area.id);
        for (const item of equipment) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "equipment", item.id, item.id);
        for (const note of notes) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "note", note.id, note.id);
        for (const task of maintenance) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "maintenance", task.id, task.id);

        const houseLinks = Object.fromEntries(houses.map((house) => [house.id, {
          stugubyId,
          authorityNodeId: this.identity.nodeId,
          publicationId: this.store.publicationId(stugubyId, "home", house.id),
          ownership: "local",
          editPolicy: "editable",
          syncState: "current",
          authorityEpoch: 1,
          pendingChangeCount: 0,
          conflictCount: 0,
          recoveryState: "not-enabled",
        } satisfies StugubyHouseLink]));
        const moved = this.database.migratePropertyInto(source.id, adoption.localPropertyId, houseLinks);
        const createdGrants = houses.flatMap((house) => {
          const grant = this.ensureRecommendedHomeOverviewGrant(stugubyId, house.id);
          return grant ? [grant] : [];
        });

        for (const area of areas) this.enqueueCorePropertyMutation(stugubyId, "area", area.id, "upsert", this.sharedArea(area));
        for (const item of equipment) this.enqueueCorePropertyMutation(
          stugubyId,
          "equipment",
          item.id,
          "upsert",
          this.sharedEquipment(stugubyId, item),
        );
        for (const note of notes) this.enqueueCorePropertyMutation(stugubyId, "note", note.id, "upsert", this.sharedNote(note));
        for (const task of maintenance) this.enqueueCorePropertyMutation(stugubyId, "maintenance", task.id, "upsert", this.sharedMaintenance(task));
        this.refreshPropertyLink(stugubyId);
        this.store.audit(stugubyId, "property.migrated", this.identity.nodeId, source.id, {
          targetPropertyId: adoption.localPropertyId,
          migrationSnapshotId,
          houses: houses.length,
          areas: areas.length,
          equipment: equipment.length,
          overviewGrants: createdGrants.length,
        });
        return { adoption: this.store.getPropertyAdoption(stugubyId)!, migrationSnapshotId, moved, createdGrants };
      });
    },
});
