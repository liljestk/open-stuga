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
import { PROPERTY_AREA_KINDS, StugubyError, grantAudienceIncludes, grantExpired } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  materializeSharedProperty(this: StugubyServiceInternals, shared: StugubySharedProperty): void {
      const adoption = this.store.getPropertyAdoption(shared.stugubyId);
      const stuguby = this.store.getStuguby(shared.stugubyId);
      if (!adoption || adoption.state !== "adopted" || !stuguby) return;
      const propertyId = adoption.localPropertyId;
      if (!this.database.getProperty(propertyId)) {
        throw new StugubyError(409, "PROPERTY_PROJECTION_MISSING", "The adopted local Property no longer exists");
      }
      this.database.updateProperty(propertyId, {
        name: shared.name,
        description: shared.description,
        location: shared.location ? { ...shared.location, source: "manual" } : null,
      });

      const areaIds = new Map(shared.areas.map((area) => [
        area.id,
        this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "area", area.id),
      ]));
      const equipmentIds = new Map(shared.equipment.map((item) => [
        item.id,
        this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "equipment", item.id),
      ]));
      const noteIds = new Map(shared.notes.map((note) => [
        note.id,
        this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "note", note.id),
      ]));
      const maintenanceIds = new Map(shared.maintenance.map((task) => [
        task.id,
        this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "maintenance", task.id),
      ]));

      for (const area of shared.areas) {
        const id = areaIds.get(area.id)!;
        const kind = PROPERTY_AREA_KINDS.has(area.kind as PropertyAreaKind) ? area.kind as PropertyAreaKind : "other";
        const existing = this.database.getPropertyArea(id);
        if (existing) {
          this.database.updatePropertyArea(id, {
            propertyId,
            name: area.name,
            kind,
            description: area.description,
            location: area.location ?? null,
            polygon: area.polygon,
          });
        } else {
          this.database.createPropertyArea({
            id,
            propertyId,
            name: area.name,
            kind,
            description: area.description,
            ...(area.location ? { location: area.location } : {}),
            polygon: area.polygon,
          });
        }
      }
      for (const item of shared.equipment) {
        const id = equipmentIds.get(item.id)!;
        const areaId = item.areaId ? areaIds.get(item.areaId) ?? null : null;
        if (item.areaId && !areaId) {
          throw new StugubyError(502, "INVALID_SHARED_PROPERTY", `Equipment ${item.id} references an unknown area`);
        }
        const projectedHouseId = item.home
          ? this.store.projectionId(
            shared.stugubyId,
            item.home.authorityNodeId,
            "home",
            item.home.publicationId,
          )
          : null;
        const houseId = projectedHouseId && this.database.getHouse(projectedHouseId)
          ? projectedHouseId
          : null;
        const existing = this.database.getAreaEquipment(id);
        if (existing) {
          this.database.updateAreaEquipment(id, {
            areaId,
            houseId,
            location: item.location ?? null,
            name: item.name,
            kind: item.kind,
            manufacturer: item.manufacturer,
            model: item.model,
            serialNumber: item.serialNumber,
            status: item.status,
            notes: item.notes,
          });
        } else {
          this.database.createAreaEquipment({
            id,
            propertyId,
            areaId,
            houseId,
            ...(item.location ? { location: item.location } : {}),
            name: item.name,
            kind: item.kind,
            manufacturer: item.manufacturer,
            model: item.model,
            serialNumber: item.serialNumber,
            status: item.status,
            notes: item.notes,
          });
        }
      }
      for (const note of shared.notes) {
        const id = noteIds.get(note.id)!;
        const value = {
          houseId: null,
          areaId: note.areaId ? areaIds.get(note.areaId) ?? null : null,
          equipmentId: note.equipmentId ? equipmentIds.get(note.equipmentId) ?? null : null,
          kind: note.kind,
          text: note.text,
        } as const;
        if (this.database.getPropertyNote(id)) this.database.updatePropertyNote(id, value);
        else this.database.createPropertyNote({ id, propertyId, ...value });
      }
      for (const task of shared.maintenance) {
        const id = maintenanceIds.get(task.id)!;
        const status = task.state === "done" ? "completed" : task.state;
        let current = this.database.getMaintenanceTask(id);
        if (!current) {
          current = this.database.createMaintenanceTask({
            id,
            propertyId,
            houseId: null,
            areaId: task.areaId ? areaIds.get(task.areaId) ?? null : null,
            equipmentId: task.equipmentId ? equipmentIds.get(task.equipmentId) ?? null : null,
            title: task.title,
            description: task.description,
            basis: "scheduled",
            dueBy: task.dueAt?.slice(0, 10) ?? null,
          }, "system-service");
        }
        const patch = {
          baseRevision: current.revision,
          areaId: task.areaId ? areaIds.get(task.areaId) ?? null : null,
          equipmentId: task.equipmentId ? equipmentIds.get(task.equipmentId) ?? null : null,
          title: task.title,
          description: task.description,
          dueBy: task.dueAt?.slice(0, 10) ?? null,
          status,
        } as const;
        this.database.updateMaintenanceTask(id, patch, "system-service");
      }

      const staleNotes = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "note")
        .filter((item) => !noteIds.has(item.remoteId));
      const staleMaintenance = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "maintenance")
        .filter((item) => !maintenanceIds.has(item.remoteId));
      const staleEquipment = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "equipment")
        .filter((item) => !equipmentIds.has(item.remoteId));
      const staleAreas = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "area")
        .filter((item) => !areaIds.has(item.remoteId));
      for (const item of staleNotes) this.database.deletePropertyNote(item.localId);
      for (const item of staleMaintenance) this.database.deleteMaintenanceTask(item.localId);
      for (const item of staleEquipment) this.database.deleteAreaEquipment(item.localId);
      for (const item of staleAreas) this.database.deletePropertyArea(item.localId);

      this.store.markPropertyMaterialized(shared.stugubyId, shared.revision);
      this.refreshPropertyLink(shared.stugubyId);
    },
  materializeAllRemoteHomes(this: StugubyServiceInternals, stugubyId: string): void {
      const grants = this.store.listGrants(stugubyId);
      const activeProjectionKeys = new Set(grants.flatMap((grant) => (
        grant.authorityNodeId !== this.identity.nodeId
          && !grant.revokedAt
          && !grantExpired(grant)
          && grantAudienceIncludes(grant, this.identity.nodeId)
          ? [`${grant.authorityNodeId}\u0000${grant.publicationId}`]
          : []
      )));
      for (const projection of this.store.listHomeProjections(stugubyId)) {
        if (!activeProjectionKeys.has(`${projection.authorityNodeId}\u0000${projection.publicationId}`)) {
          this.removeRemoteHomeProjection(stugubyId, projection.authorityNodeId, projection.publicationId);
        }
      }
      for (const grant of grants) {
        if (grant.authorityNodeId === this.identity.nodeId
          || grant.revokedAt
          || grantExpired(grant)
          || !grantAudienceIncludes(grant, this.identity.nodeId)) continue;
        this.materializeRemoteHome(stugubyId, grant.authorityNodeId, grant.publicationId);
      }
    },
});
