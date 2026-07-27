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
import { grantExpired, recoveryAssetReferences } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  materializeRemoteHome(this: StugubyServiceInternals, stugubyId: string, authorityNodeId: string, publicationId: string): void {
      const adoption = this.store.getPropertyAdoption(stugubyId);
      if (!adoption || adoption.state !== "adopted") return;
      const grant = this.store.listGrants(stugubyId, authorityNodeId)
        .find((item) => item.publicationId === publicationId && !item.revokedAt && !grantExpired(item));
      if (!grant) return;
      const resources = this.store.listRemoteResources(stugubyId)
        .filter((resource) => resource.authorityNodeId === authorityNodeId && resource.publicationId === publicationId);
      const bySchema = new Map(resources.map((resource) => [resource.schema, resource]));
      const directory = bySchema.get("home.directory.v1")?.payload as unknown as StugubyHomeDirectoryPayload | undefined;
      if (!directory) return;

      const localHouseId = this.store.projectionId(stugubyId, authorityNodeId, "home", publicationId);
      const structure = bySchema.get("home.structure.v1")?.payload as unknown as StugubyHomeStructurePayload | undefined;
      const floorIds = new Map<string, string>();
      const roomIds = new Map<string, string>();
      const floors: Floor[] | undefined = structure?.floors.map((floor) => {
        const floorId = this.store.projectionId(stugubyId, authorityNodeId, "floor", floor.floorPublicationId);
        floorIds.set(floor.floorPublicationId, floorId);
        const wallIds = new Map(floor.walls.map((wall) => [
          wall.wallPublicationId,
          this.store.projectionId(stugubyId, authorityNodeId, "wall", wall.wallPublicationId),
        ]));
        const rooms = floor.rooms.map((room) => {
          const roomId = this.store.projectionId(stugubyId, authorityNodeId, "room", room.roomPublicationId);
          roomIds.set(room.roomPublicationId, roomId);
          return {
            id: roomId,
            name: room.name,
            points: room.points.map((point) => ({ x: point.x, y: point.y })),
            ...(room.kind ? { kind: room.kind } : {}),
          };
        });
        const planElements = floor.planElements.flatMap((element) => {
          if (!["door", "window", "fireplace", "vent", "fireEscape"].includes(element.kind)) return [];
          const projected: Record<string, unknown> = {
            id: this.store.projectionId(stugubyId, authorityNodeId, "plan-element", element.planElementPublicationId),
            kind: element.kind,
            position: { x: element.position.x, y: element.position.y },
            rotationDegrees: element.rotationDegrees,
          };
          for (const key of ["width", "height", "label", "state", "openFraction", "bottomOffsetM", "variant",
            "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
            if (element[key] !== undefined) projected[key] = element[key];
          }
          if (element.wallPublicationId) {
            const wallId = wallIds.get(element.wallPublicationId);
            if (!wallId) return [];
            projected.wallId = wallId;
          }
          return [projected];
        });
        const projected: Record<string, unknown> = {
          id: floorId,
          name: floor.name,
          width: floor.width,
          height: floor.height,
          elevation: floor.elevation,
          walls: floor.walls.map((wall) => ({
            id: wallIds.get(wall.wallPublicationId)!,
            from: { x: wall.from.x, y: wall.from.y },
            to: { x: wall.to.x, y: wall.to.y },
          })),
          rooms,
          planElements,
        };
        for (const key of ["type", "metersPerPlanUnit", "ceilingHeight", "wallHeight"] as const) {
          if (floor[key] !== undefined) projected[key] = floor[key];
        }
        if (floor.roof) projected.roof = { ...floor.roof };
        return projected as unknown as Floor;
      });

      const locationPayload = bySchema.get("home.location.v1")?.payload as unknown as StugubyHomeLocationPayload | undefined;
      const location = locationPayload ? {
        latitude: locationPayload.latitude,
        longitude: locationPayload.longitude,
        ...(locationPayload.label ? { label: locationPayload.label } : {}),
        ...(locationPayload.countryCode ? { countryCode: locationPayload.countryCode } : {}),
        source: "manual" as const,
      } : undefined;
      const footprintFloorId = locationPayload?.mapPlacement?.footprintFloorPublicationId
        ? floorIds.get(locationPayload.mapPlacement.footprintFloorPublicationId)
        : undefined;
      const mapPlacement = locationPayload?.mapPlacement ? {
        latitude: locationPayload.mapPlacement.latitude,
        longitude: locationPayload.mapPlacement.longitude,
        metersPerPlanUnit: locationPayload.mapPlacement.metersPerPlanUnit,
        ...(footprintFloorId ? { footprintFloorId } : {}),
      } : undefined;

      let house = this.database.getHouse(localHouseId);
      if (house && floors) {
        const validFloorIds = new Set(floors.map((floor) => floor.id));
        for (const sensor of this.database.listSensors(house.id)) {
          if (sensor.tags.includes("stuguby-shared") && !validFloorIds.has(sensor.floorId)) this.database.deleteSensor(sensor.id);
        }
      }
      if (!house) {
        house = this.database.createHouse({
          id: localHouseId,
          propertyId: adoption.localPropertyId,
          name: directory.name,
          timezone: directory.timezone,
          ...(location ? { location } : {}),
          ...(mapPlacement ? { mapPlacement } : {}),
          ...(locationPayload?.orientationDegrees !== undefined ? { orientationDegrees: locationPayload.orientationDegrees } : {}),
          floors: floors ?? [],
        });
      } else {
        house = this.database.updateHouse(house.id, {
          propertyId: adoption.localPropertyId,
          name: directory.name,
          timezone: directory.timezone,
          ...(location ? { location } : {}),
          ...(mapPlacement ? { mapPlacement } : {}),
          ...(locationPayload?.orientationDegrees !== undefined ? { orientationDegrees: locationPayload.orientationDegrees } : {}),
          ...(floors ? { floors } : {}),
        }, "system-service")!;
      }

      const floorPlan = bySchema.get("home.floorplan.v1")?.payload as unknown as StugubyHomeFloorPlanPayload | undefined;
      if (floorPlan && floors) {
        const floorById = new Map(house.floors.map((floor) => [floor.id, { ...floor }]));
        for (const asset of floorPlan.assets) {
          const localFloorId = floorIds.get(asset.floorPublicationId);
          const floor = localFloorId ? floorById.get(localFloorId) : null;
          if (!floor) continue;
          try {
            const blob = this.readBlob(asset.image.digest);
            floor.backgroundImage = `data:${blob.mediaType};base64,${blob.data.toString("base64")}`;
          } catch {
            // The recovery state below remains incomplete until the cached blob arrives.
          }
        }
        house = this.database.updateHouse(house.id, { floors: [...floorById.values()] }, "system-service")!;
      }

      const sensorCatalog = bySchema.get("home.sensor-catalog.v1")?.payload as unknown as StugubySensorCatalogPayload | undefined;
      if (sensorCatalog) {
        const expected = new Set<string>();
        for (const item of sensorCatalog.sensors) {
          const floorId = floorIds.get(item.floorPublicationId);
          if (!floorId) continue;
          const id = this.store.projectionId(stugubyId, authorityNodeId, "sensor", item.sensorPublicationId);
          expected.add(id);
          const roomId = item.roomPublicationId ? roomIds.get(item.roomPublicationId) ?? null : null;
          const room = roomId
            ? house.floors.find((floor) => floor.id === floorId)?.rooms.find((candidate) => candidate.id === roomId)?.name ?? ""
            : "";
          const existing = this.database.getSensor(id);
          if (existing) {
            this.database.updateSensor(id, {
              houseId: house.id,
              floorId,
              name: item.name,
              roomId,
              room,
              model: item.model,
              x: item.x,
              y: item.y,
              z: item.z,
              tags: [...item.tags.filter((tag) => tag !== "stuguby-shared"), "stuguby-shared"],
              enabled: item.enabled,
              measurementEntityIds: {},
            });
          } else {
            this.database.createSensor({
              id,
              houseId: house.id,
              floorId,
              name: item.name,
              roomId,
              room,
              model: item.model,
              x: item.x,
              y: item.y,
              z: item.z,
              tags: [...item.tags.filter((tag) => tag !== "stuguby-shared"), "stuguby-shared"],
              enabled: item.enabled,
            });
          }
        }
        for (const sensor of this.database.listSensors(house.id)) {
          if (sensor.tags.includes("stuguby-shared") && !expected.has(sensor.id)) this.database.deleteSensor(sensor.id);
        }
      }

      const notesPayload = bySchema.get("home.notes.v1")?.payload as unknown as StugubyHomeNotesPayload | undefined;
      if (notesPayload) {
        const expected = new Set<string>();
        for (const item of notesPayload.notes) {
          const id = this.store.projectionId(stugubyId, authorityNodeId, "home-note", item.notePublicationId);
          expected.add(id);
          const existing = this.database.getPropertyNote(id);
          if (existing) {
            this.database.updatePropertyNote(id, { houseId: house.id, areaId: null, equipmentId: null, kind: item.kind, text: item.text });
          } else {
            this.database.createPropertyNote({
              id,
              propertyId: adoption.localPropertyId,
              houseId: house.id,
              areaId: null,
              equipmentId: null,
              kind: item.kind,
              text: item.text,
            });
          }
          this.database.db.prepare("UPDATE property_notes SET created_at=?,updated_at=? WHERE id=?")
            .run(item.createdAt, item.updatedAt, id);
        }
        for (const projection of this.store.listProjectionIds(stugubyId, authorityNodeId, "home-note")) {
          if (!expected.has(projection.localId)) this.database.deletePropertyNote(projection.localId);
        }
      }

      const observationsPayload = bySchema.get("home.observations.v1")?.payload as unknown as StugubyHomeObservationsPayload | undefined;
      if (observationsPayload) {
        const expected = new Set<string>();
        for (const item of observationsPayload.observations) {
          const floorId = floorIds.get(item.floorPublicationId);
          if (!floorId) continue;
          const sensorId = item.sensorPublicationId
            ? this.store.projectionId(stugubyId, authorityNodeId, "sensor", item.sensorPublicationId)
            : null;
          if (sensorId && !this.database.getSensor(sensorId)) continue;
          const id = this.store.projectionId(stugubyId, authorityNodeId, "observation", item.observationPublicationId);
          expected.add(id);
          const existing = this.database.getObservation(id);
          if (!existing) {
            this.database.createObservation({
              id,
              houseId: house.id,
              floorId,
              sensorId,
              kind: item.kind as never,
              severity: item.severity as never,
              note: item.note,
              x: item.x,
              y: item.y,
              occurredAt: item.occurredAt,
              ...(item.timePrecision ? { timePrecision: item.timePrecision as never } : {}),
              ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
              ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
              source: "unknown",
              sourceDetail: "Stuguby shared history",
              ...(item.confidence ? { confidence: item.confidence as never } : {}),
            }, "system-service");
          } else {
            this.database.updateObservation(id, {
              baseRevision: existing.revision,
              floorId,
              sensorId,
              kind: item.kind as never,
              severity: item.severity as never,
              note: item.note,
              x: item.x,
              y: item.y,
              occurredAt: item.occurredAt,
              ...(item.timePrecision ? { timePrecision: item.timePrecision as never } : {}),
              ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
              ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
              ...(item.confidence ? { confidence: item.confidence as never } : {}),
              ...(item.status ? { status: item.status as never } : {}),
              ...(item.resolutionNote !== undefined ? { resolutionNote: item.resolutionNote } : {}),
            }, "system-service");
          }
        }
        for (const projection of this.store.listProjectionIds(stugubyId, authorityNodeId, "observation")) {
          if (!expected.has(projection.localId)) this.database.deleteObservation(projection.localId);
        }
      }

      const recoveryEligible = grant.housePolicy.recoveryMode === "full"
        && grant.housePolicy.designatedSuccessorNodeId === this.identity.nodeId;
      const requiredSchemas: StugubyDataset[] = [
        "home.directory.v1", "home.structure.v1", "home.floorplan.v1",
        "home.sensor-catalog.v1", "home.notes.v1", "home.observations.v1", "home.recovery.v1",
      ];
      const recoveryPayloads = resources
        .filter((resource) => resource.schema === "home.recovery.v1")
        .map((resource) => resource.payload as unknown as StugubyHomeRecoveryPayload);
      const recoveryGeneration = Math.max(0, ...recoveryPayloads.map((payload) => payload.generation));
      const currentRecovery = recoveryPayloads.filter((payload) => payload.generation === recoveryGeneration);
      const recoveryKinds: StugubyHomeRecoveryKind[] = [
        "manifest", "measurement-definitions", "alert-rules", "alert-events", "static-parameters",
        "opening-states", "weather-history", "electricity-history", "assets",
      ];
      const manifest = currentRecovery.find((payload) => payload.kind === "manifest" && payload.complete)
        ?.records[0] as { telemetrySamples?: number } | undefined;
      const recoveryArchiveReady = recoveryKinds.every((kind) => currentRecovery.some((payload) => (
        payload.kind === kind && payload.complete
      ))) && Number.isSafeInteger(manifest?.telemetrySamples)
        && this.store.remoteTelemetryCount(stugubyId, authorityNodeId, publicationId) >= Number(manifest?.telemetrySamples ?? Infinity);
      const recoveryAssets = currentRecovery.flatMap(recoveryAssetReferences);
      const blobsReady = (!floorPlan || floorPlan.assets.every((asset) => {
        try { this.readBlob(asset.image.digest); return true; } catch { return false; }
      })) && recoveryAssets.every((asset) => {
        try {
          const blob = this.readBlob(asset.digest);
          return blob.data.byteLength === asset.byteLength && blob.mediaType === asset.mediaType;
        } catch {
          return false;
        }
      });
      const recoveryReady = recoveryEligible
        && requiredSchemas.every((schema) => bySchema.has(schema))
        && recoveryArchiveReady
        && blobsReady;
      const syncedThrough = resources.map((resource) => resource.receivedAt).sort().at(-1) ?? null;
      const projection: StugubyHomeProjection = {
        stugubyId,
        authorityNodeId,
        publicationId,
        localHouseId: house.id,
        editPolicy: grant.housePolicy.editPolicy,
        recoveryMode: grant.housePolicy.recoveryMode,
        recoveryState: recoveryEligible ? (recoveryReady ? "ready" : "syncing") : "not-enabled",
        designatedSuccessorNodeId: grant.housePolicy.designatedSuccessorNodeId,
        recoverySyncedThrough: recoveryReady ? syncedThrough : null,
        authorityEpoch: 1,
        detachedAt: null,
        updatedAt: new Date().toISOString(),
      };
      this.store.upsertHomeProjection(projection);
      const commandCounts = this.store.homeCommandCountsFor(stugubyId, authorityNodeId, publicationId);
      const syncState = resources.some((resource) => resource.stale)
        ? "offline"
        : commandCounts.conflicts > 0
          ? "conflict"
          : commandCounts.pending > 0
            ? "pending"
            : "current";
      this.database.setHouseStugubyLink(house.id, {
        stugubyId,
        authorityNodeId,
        publicationId,
        ownership: "shared",
        editPolicy: projection.editPolicy,
        syncState,
        authorityEpoch: projection.authorityEpoch,
        pendingChangeCount: commandCounts.pending,
        conflictCount: commandCounts.conflicts,
        recoveryState: projection.recoveryState,
        ...(projection.designatedSuccessorNodeId ? { designatedSuccessorNodeId: projection.designatedSuccessorNodeId } : {}),
        ...(projection.recoverySyncedThrough ? { recoverySyncedThrough: projection.recoverySyncedThrough } : {}),
      });
      const sharedProperty = this.store.getSharedProperty(stugubyId);
      if (sharedProperty?.equipment.some((item) => (
        item.home?.authorityNodeId === authorityNodeId
        && item.home.publicationId === publicationId
      ))) {
        this.materializeSharedProperty(sharedProperty);
      }
    },
});
