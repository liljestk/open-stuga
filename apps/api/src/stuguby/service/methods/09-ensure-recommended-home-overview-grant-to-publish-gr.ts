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
import { StugubyError, asJson, grantExpired, parseIso, recommendedHomeOverviewDatasets, requiredText, withoutLocalGrantIdentity } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  ensureRecommendedHomeOverviewGrant(this: StugubyServiceInternals, stugubyId: string, localHouseId: string): StugubyShareGrant | null {
      const existing = this.store.listGrants(stugubyId, this.identity.nodeId)
        .find((grant) => grant.localHouseId === localHouseId && !grant.revokedAt && !grantExpired(grant));
      if (existing) return null;
      return this.createGrant(stugubyId, {
        localHouseId,
        audience: { kind: "all-members", nodeIds: [] },
        datasets: recommendedHomeOverviewDatasets(),
        housePolicy: {
          editPolicy: "read-only",
          recoveryMode: "none",
          designatedSuccessorNodeId: null,
        },
        expiresAt: null,
      });
    },
  backfillRecommendedHomeOverviews(this: StugubyServiceInternals, stugubyId: string): void {
      const stuguby = this.store.getStuguby(stugubyId);
      const adoption = this.store.getPropertyAdoption(stugubyId);
      if (!stuguby || stuguby.localMemberState !== "active" || stuguby.localRole === "viewer"
        || !adoption || adoption.state !== "adopted") return;
      const grants = this.store.listGrants(stugubyId, this.identity.nodeId);
      for (const house of this.database.listHouses(adoption.localPropertyId)) {
        if (house.stuguby?.stugubyId !== stugubyId || house.stuguby.ownership !== "local") continue;
        // Never replace an explicitly revoked or expired grant. This only repairs
        // Homes linked by the older Property flow, which created no grant at all.
        if (!grants.some((grant) => grant.localHouseId === house.id)) {
          this.ensureRecommendedHomeOverviewGrant(stugubyId, house.id);
        }
      }
    },
  createGrant(this: StugubyServiceInternals, stugubyId: string, input: {
      localHouseId: string;
      audience: StugubyGrantAudience;
      datasets: StugubyDatasetGrant[];
      housePolicy?: StugubyShareGrant["housePolicy"];
      expiresAt?: string | null;
    }): StugubyShareGrant {
      this.requireLocalPublisher(stugubyId);
      const house = this.database.getHouse(requiredText(input.localHouseId, "House id"));
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Local house was not found");
      const publicationId = this.store.publicationId(stugubyId, "home", house.id);
      const now = new Date().toISOString();
      const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
      if (expiresAt && expiresAt <= now) throw new StugubyError(400, "INVALID_EXPIRY", "Grant expiry must be in the future");
      const grant: StugubyShareGrant = {
        id: randomUUID(),
        stugubyId,
        authorityNodeId: this.identity.nodeId,
        publicationId,
        localHouseId: house.id,
        audience: input.audience,
        datasets: input.datasets,
        housePolicy: input.housePolicy ?? {
          editPolicy: "read-only",
          recoveryMode: "none",
          designatedSuccessorNodeId: null,
        },
        epoch: 1,
        revision: 1,
        expiresAt,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      if (grant.housePolicy.editPolicy === "editable" && !this.store.isCoordinator(stugubyId)) {
        throw new StugubyError(409, "EDITABLE_HOME_REQUIRES_COORDINATOR_AUTHORITY", "Only a coordinator-owned Home can currently accept shared edits");
      }
      this.validateEditableHomeGrant(grant);
      this.validateGrantAgainstMembership(grant);
      validateShareGrant(grant);
      this.atomicPublication(() => {
        this.validateUniqueRecoverySuccessor(grant);
        this.validateUniqueActiveHomeGrant(grant);
        this.store.upsertGrant(grant);
        this.store.audit(stugubyId, "grant.created", this.identity.nodeId, grant.id, {
          revision: grant.revision, epoch: grant.epoch, audience: grant.audience.kind,
          enabledDatasets: grant.datasets.filter((dataset) => dataset.enabled).length,
        });
        this.publishGrant(grant, "grant.upserted");
        this.publishGrantSnapshots(grant, house);
      });
      this.markLocalSharedHouse(grant, house);
      return grant;
    },
  localPublicationCatalog(this: StugubyServiceInternals, stugubyId: string, localHouseId: string): {
      house: { localHouseId: string; publicationId: string; name: string };
      sensors: Array<{ localSensorId: string; sensorPublicationId: string; name: string; metricIds: string[] }>;
    } {
      this.requireLocalPublisher(stugubyId);
      const house = this.database.getHouse(requiredText(localHouseId, "House id"));
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Local house was not found");
      return {
        house: {
          localHouseId: house.id,
          publicationId: this.store.publicationId(stugubyId, "home", house.id),
          name: house.name,
        },
        sensors: this.database.listSensors(house.id).map((sensor) => ({
          localSensorId: sensor.id,
          sensorPublicationId: this.store.publicationId(stugubyId, "sensor", sensor.id),
          name: sensor.name,
          metricIds: this.sensorMetrics(sensor.id),
        })),
      };
    },
  updateGrant(this: StugubyServiceInternals, grantId: string, baseRevision: number, input: Pick<StugubyShareGrant, "audience" | "datasets" | "expiresAt" | "housePolicy">): StugubyShareGrant {
      const existing = this.store.getGrant(grantId);
      if (!existing) throw new StugubyError(404, "GRANT_NOT_FOUND", "Share grant was not found");
      if (existing.authorityNodeId !== this.identity.nodeId) throw new StugubyError(403, "GRANT_AUTHORITY_REQUIRED", "Only the authoritative local Stugu may edit this grant");
      if (existing.revokedAt) throw new StugubyError(409, "GRANT_REVOKED", "A revoked grant cannot be edited");
      this.requireLocalPublisher(existing.stugubyId);
      if (existing.revision !== baseRevision) throw new StugubyError(409, "REVISION_CONFLICT", `Current grant revision is ${existing.revision}`);
      const retiredAt = new Date().toISOString();
      const retired: StugubyShareGrant = {
        ...existing,
        epoch: existing.epoch + 1,
        revision: existing.revision + 1,
        revokedAt: retiredAt,
        updatedAt: retiredAt,
      };
      const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
      if (expiresAt && expiresAt <= retiredAt) throw new StugubyError(400, "INVALID_EXPIRY", "Grant expiry must be in the future");
      const grant: StugubyShareGrant = {
        ...existing,
        audience: input.audience,
        datasets: input.datasets,
        housePolicy: input.housePolicy,
        expiresAt,
        epoch: existing.epoch + 2,
        revision: existing.revision + 2,
        revokedAt: null,
        updatedAt: new Date().toISOString(),
      };
      if (grant.housePolicy.editPolicy === "editable" && !this.store.isCoordinator(existing.stugubyId)) {
        throw new StugubyError(409, "EDITABLE_HOME_REQUIRES_COORDINATOR_AUTHORITY", "Only a coordinator-owned Home can currently accept shared edits");
      }
      this.validateEditableHomeGrant(grant);
      this.validateGrantAgainstMembership(grant);
      validateShareGrant(grant);
      const house = this.database.getHouse(existing.localHouseId ?? "");
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Grant house was not found");
      // Every former recipient first receives a tombstone and must acknowledge
      // deletion. Continuing recipients then receive a fresh epoch and snapshot.
      this.atomicPublication(() => {
        this.validateUniqueRecoverySuccessor(grant);
        this.store.discardOutboxGrantEpoch(existing.stugubyId, existing.id, existing.epoch);
        this.publishGrant(retired, "grant.revoked");
        this.store.upsertGrant(grant);
        this.store.audit(grant.stugubyId, "grant.updated", this.identity.nodeId, grant.id, {
          revision: grant.revision, epoch: grant.epoch, audience: grant.audience.kind,
          enabledDatasets: grant.datasets.filter((dataset) => dataset.enabled).length,
        });
        this.publishGrant(grant, "grant.upserted");
        this.publishGrantSnapshots(grant, house);
        this.store.retireLocalBlobReferences(grant.stugubyId, grant.id, existing.epoch);
      });
      this.markLocalSharedHouse(grant, house);
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
      return grant;
    },
  revokeGrant(this: StugubyServiceInternals, grantId: string): StugubyShareGrant {
      const previous = this.store.getGrant(grantId);
      if (!previous) throw new StugubyError(404, "GRANT_NOT_FOUND", "Share grant was not found");
      if (previous.authorityNodeId !== this.identity.nodeId) throw new StugubyError(403, "GRANT_AUTHORITY_REQUIRED", "Only the authoritative local Stugu may revoke this grant");
      if (previous.revokedAt) throw new StugubyError(409, "GRANT_REVOKED", "Share grant is already revoked");
      this.requireLocalPublisher(previous.stugubyId);
      const revoked = this.atomicPublication(() => {
        const retired = this.store.revokeGrant(grantId);
        // Keep the old audience on the revocation so every former recipient purges its replica.
        this.store.discardOutboxGrantEpoch(previous.stugubyId, previous.id, previous.epoch);
        this.publishGrant({ ...retired, audience: previous.audience }, "grant.revoked");
        this.store.audit(retired.stugubyId, "grant.revoked", this.identity.nodeId, retired.id, { epoch: retired.epoch });
        this.store.retireLocalBlobReferences(retired.stugubyId, retired.id, previous.epoch);
        return retired;
      });
      this.refreshLocalSharedHouseLink(revoked.stugubyId, previous.localHouseId ?? "");
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
      return revoked;
    },
  republishGrant(this: StugubyServiceInternals, grantId: string): void {
      const grant = this.store.getGrant(grantId);
      if (!grant || grant.authorityNodeId !== this.identity.nodeId || grant.revokedAt || grantExpired(grant)) throw new StugubyError(404, "GRANT_NOT_FOUND", "Active local share grant was not found");
      this.requireLocalPublisher(grant.stugubyId);
      const house = this.database.getHouse(grant.localHouseId ?? "");
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Grant house was not found");
      this.publishGrant(grant, "grant.upserted");
      this.publishGrantSnapshots(grant, house);
      this.store.audit(grant.stugubyId, "grant.republished", this.identity.nodeId, grant.id, { revision: grant.revision, epoch: grant.epoch });
    },
  validateGrantAgainstMembership(this: StugubyServiceInternals, grant: StugubyShareGrant, authorityNodeId = this.identity.nodeId): void {
      if (grant.audience.kind === "members" && grant.audience.nodeIds.length === 0) {
        throw new StugubyError(400, "EMPTY_AUDIENCE", "A member-specific grant requires at least one participant");
      }
      const active = new Set(this.store.listMembers(grant.stugubyId).filter((member) => member.state === "active").map((member) => member.nodeId));
      for (const nodeId of grant.audience.nodeIds) {
        if (!active.has(nodeId) || nodeId === authorityNodeId) throw new StugubyError(400, "INVALID_AUDIENCE", `Node ${nodeId} is not an eligible active participant`);
      }
      const successor = grant.housePolicy.designatedSuccessorNodeId;
      if (successor && (!active.has(successor) || successor === authorityNodeId)) {
        throw new StugubyError(400, "INVALID_SUCCESSOR", "The designated Home successor must be one active remote member");
      }
    },
  validateEditableHomeGrant(this: StugubyServiceInternals, grant: StugubyShareGrant): void {
      if (grant.housePolicy.editPolicy !== "editable") return;
      const enabled = new Map(grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => [dataset.dataset, dataset]));
      for (const dataset of [
        "home.directory.v1", "home.location.v1", "home.structure.v1",
        "home.sensor-catalog.v1", "home.notes.v1", "home.observations.v1",
      ] as const) {
        const policy = enabled.get(dataset);
        if (!policy?.allowReplicaCache || policy.retentionDays < 1) {
          throw new StugubyError(
            400,
            "EDITABLE_HOME_DATASETS_REQUIRED",
            "Editable Homes require directory, location, structure, sensors, notes, and observations with durable local caching",
          );
        }
      }
    },
  validateUniqueRecoverySuccessor(this: StugubyServiceInternals, grant: StugubyShareGrant): void {
      if (grant.housePolicy.recoveryMode !== "full") return;
      const successor = grant.housePolicy.designatedSuccessorNodeId;
      const competing = this.store.listGrants(grant.stugubyId, grant.authorityNodeId)
        .find((candidate) => candidate.id !== grant.id
          && candidate.localHouseId === grant.localHouseId
          && candidate.housePolicy.recoveryMode === "full"
          && candidate.housePolicy.designatedSuccessorNodeId !== successor
          && !candidate.revokedAt
          && !grantExpired(candidate));
      if (competing) {
        throw new StugubyError(
          409,
          "HOME_SUCCESSOR_ALREADY_DESIGNATED",
          "This Home already has a different designated recovery successor",
        );
      }
    },
  validateUniqueActiveHomeGrant(this: StugubyServiceInternals, grant: StugubyShareGrant): void {
      const existing = this.store.listGrants(grant.stugubyId, grant.authorityNodeId)
        .find((candidate) => candidate.id !== grant.id
          && candidate.localHouseId === grant.localHouseId
          && !candidate.revokedAt
          && !grantExpired(candidate));
      if (existing) {
        throw new StugubyError(
          409,
          "HOME_ALREADY_SHARED",
          "This Home already has an active share grant. Update or revoke it before creating another",
        );
      }
    },
  markLocalHouseInAdoptedProperty(this: StugubyServiceInternals, houseId: string): House {
      const house = this.database.getHouse(houseId);
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Home was not found");
      const propertyLink = this.database.getProperty(house.propertyId)?.stuguby;
      if (!propertyLink || propertyLink.syncState === "detached") return house;
      if (house.stuguby && house.stuguby.stugubyId !== propertyLink.stugubyId
        && house.stuguby.syncState !== "detached") {
        throw new StugubyError(409, "HOUSE_ALREADY_SHARED", "This Home already belongs to another Stuguby");
      }
      const linked = this.database.setHouseStugubyLink(house.id, {
        stugubyId: propertyLink.stugubyId,
        authorityNodeId: this.identity.nodeId,
        publicationId: this.store.publicationId(propertyLink.stugubyId, "home", house.id),
        ownership: "local",
        editPolicy: "editable",
        syncState: "current",
        authorityEpoch: house.stuguby?.authorityEpoch ?? 1,
        pendingChangeCount: 0,
        conflictCount: 0,
        recoveryState: "not-enabled",
      })!;
      this.ensureRecommendedHomeOverviewGrant(propertyLink.stugubyId, house.id);
      return linked;
    },
  markLocalSharedHouse(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House): void {
      const existing = this.database.getHouse(house.id);
      if (!existing) return;
      this.database.setHouseStugubyLink(house.id, {
        stugubyId: grant.stugubyId,
        authorityNodeId: this.identity.nodeId,
        publicationId: grant.publicationId,
        ownership: "local",
        editPolicy: "editable",
        syncState: "current",
        authorityEpoch: existing.stuguby?.authorityEpoch ?? 1,
        pendingChangeCount: 0,
        conflictCount: 0,
        recoveryState: "not-enabled",
      });
    },
  refreshLocalSharedHouseLink(this: StugubyServiceInternals, stugubyId: string, houseId: string): void {
      const house = this.database.getHouse(houseId);
      if (!house?.stuguby || house.stuguby.stugubyId !== stugubyId || house.stuguby.ownership !== "local") return;
      const stillShared = this.store.listGrants(stugubyId, this.identity.nodeId)
        .some((grant) => grant.localHouseId === houseId && !grant.revokedAt && !grantExpired(grant));
      if (stillShared) return;
      const propertyLink = this.database.getProperty(house.propertyId)?.stuguby;
      if (!propertyLink || propertyLink.stugubyId !== stugubyId || propertyLink.syncState === "detached") {
        this.database.setHouseStugubyLink(houseId, null);
      }
    },
  publishGrant(this: StugubyServiceInternals, grant: StugubyShareGrant, eventKind: "grant.upserted" | "grant.revoked"): void {
      const wireGrant = withoutLocalGrantIdentity(grant);
      const event = this.createEvent({
        stugubyId: grant.stugubyId,
        eventKind,
        streamId: `grant:${grant.id}`,
        schema: "stuguby.grant.v2",
        resourceId: grant.id,
        operation: eventKind === "grant.revoked" ? "tombstone" : "upsert",
        revision: grant.revision,
        grantId: grant.id,
        grantEpoch: grant.epoch,
        payload: asJson(wireGrant),
      });
      this.distribute(event, grant);
    },
});
