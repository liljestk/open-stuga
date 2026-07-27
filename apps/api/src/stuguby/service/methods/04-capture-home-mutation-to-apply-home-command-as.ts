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
import { StugubyError, grantAudienceIncludes, grantExpired } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  captureHomeMutation(this: StugubyServiceInternals, houseId: string): StugubyHomeCommand | null {
      const house = this.database.getHouse(houseId);
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Home was not found");
      const link = house.stuguby;
      if (!link || link.syncState === "detached") return null;
      if (link.ownership === "local") {
        const grants = this.store.listGrants(link.stugubyId, this.identity.nodeId)
          .filter((grant) => grant.localHouseId === house.id && !grant.revokedAt && !grantExpired(grant));
        if (grants.length === 0) return null;
        this.atomicPublication(() => {
          const revision = this.store.bumpHomeRevision(link.stugubyId, this.identity.nodeId, link.publicationId);
          for (const grant of grants) this.publishGrantSnapshots(grant, house, revision);
          this.store.audit(link.stugubyId, "home.updated", this.identity.nodeId, link.publicationId, { revision });
        });
        return null;
      }
      this.assertHouseWriteAllowed(house.id);
      const grant = this.store.listGrants(link.stugubyId, link.authorityNodeId)
        .find((candidate) => candidate.publicationId === link.publicationId
          && candidate.housePolicy.editPolicy === "editable"
          && !candidate.revokedAt
          && !grantExpired(candidate)
          && grantAudienceIncludes(candidate, this.identity.nodeId));
      if (!grant) throw new StugubyError(409, "EDITABLE_HOME_GRANT_MISSING", "The editable Home grant is no longer active");
      const pending = this.store.pendingHomeCommandFor(link.stugubyId, link.authorityNodeId, link.publicationId);
      const resources = this.store.listRemoteResources(link.stugubyId)
        .filter((resource) => resource.authorityNodeId === link.authorityNodeId
          && resource.publicationId === link.publicationId);
      const baseRevision = pending?.command.baseRevision
        ?? Math.max(1, ...resources.map((resource) => resource.revision));
      const command: StugubyHomeCommand = {
        id: pending?.command.id ?? randomUUID(),
        stugubyId: link.stugubyId,
        actorNodeId: this.identity.nodeId,
        authorityNodeId: link.authorityNodeId,
        publicationId: link.publicationId,
        grantId: grant.id,
        grantEpoch: grant.epoch,
        authorityEpoch: link.authorityEpoch,
        baseRevision,
        snapshot: this.editableHomeSnapshot(house),
        createdAt: pending?.command.createdAt ?? new Date().toISOString(),
      };
      validateHomeCommand(command);
      this.store.enqueueHomeCommand(command);
      const commandCounts = this.store.homeCommandCountsFor(link.stugubyId, link.authorityNodeId, link.publicationId);
      this.database.setHouseStugubyLink(house.id, {
        ...link,
        syncState: "pending",
        pendingChangeCount: commandCounts.pending,
        conflictCount: commandCounts.conflicts,
      });
      this.store.audit(link.stugubyId, "home.command.queued", this.identity.nodeId, link.publicationId, {
        commandId: command.id,
        baseRevision,
      });
      return command;
    },
  editableHomeSnapshot(this: StugubyServiceInternals, house: House): StugubyHomeCommandSnapshot {
      const link = house.stuguby;
      if (!link || link.ownership !== "shared") throw new StugubyError(409, "HOME_NOT_SHARED", "The Home is not a shared projection");
      const remoteId = (
        type: "floor" | "room" | "wall" | "plan-element" | "sensor" | "home-note" | "observation",
        localId: string,
      ) => this.store.projectionRemoteId(link.stugubyId, link.authorityNodeId, type, localId);
      const structure = {
        publicationId: link.publicationId,
        floors: house.floors.map((floor) => {
          const walls = floor.walls.map((wall) => ({
            wallPublicationId: remoteId("wall", wall.id),
            from: { x: wall.from.x, y: wall.from.y },
            to: { x: wall.to.x, y: wall.to.y },
          }));
          const rooms = floor.rooms.map((room) => ({
            roomPublicationId: remoteId("room", room.id),
            name: room.name,
            points: room.points.map((point) => ({ x: point.x, y: point.y })),
            ...(room.kind ? { kind: room.kind } : {}),
          }));
          const planElements = (floor.planElements ?? []).map((element) => {
            const projected: Record<string, JsonValue> = {
              planElementPublicationId: remoteId("plan-element", element.id),
              kind: element.kind,
              position: { x: element.position.x, y: element.position.y },
              rotationDegrees: element.rotationDegrees,
            };
            for (const key of ["width", "height", "label", "state", "openFraction", "bottomOffsetM", "variant",
              "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
              const value = element[key as keyof typeof element];
              if (value !== undefined) projected[key] = value as JsonValue;
            }
            if ("wallId" in element && typeof element.wallId === "string") {
              projected.wallPublicationId = remoteId("wall", element.wallId);
            }
            return projected;
          });
          const result: Record<string, JsonValue> = {
            floorPublicationId: remoteId("floor", floor.id),
            name: floor.name,
            width: floor.width,
            height: floor.height,
            elevation: floor.elevation,
            walls,
            rooms,
            planElements,
          };
          for (const [key, value] of [
            ["type", floor.type], ["metersPerPlanUnit", floor.metersPerPlanUnit], ["ceilingHeight", floor.ceilingHeight],
            ["wallHeight", floor.wallHeight], ["roof", floor.roof ? {
              style: floor.roof.style,
              pitchDegrees: floor.roof.pitchDegrees,
              ridgeAxis: floor.roof.ridgeAxis,
              overhang: floor.roof.overhang,
              eavesHeight: floor.roof.eavesHeight,
            } : undefined],
          ] as const) if (value !== undefined) result[key] = value as JsonValue;
          return result;
        }),
      } as unknown as StugubyHomeStructurePayload;
      const location: StugubyHomeLocationPayload | null = house.location ? {
        publicationId: link.publicationId,
        latitude: house.location.latitude,
        longitude: house.location.longitude,
        ...(house.location.label ? { label: house.location.label } : {}),
        ...(house.location.countryCode ? { countryCode: house.location.countryCode } : {}),
        ...(house.mapPlacement ? { mapPlacement: {
          latitude: house.mapPlacement.latitude,
          longitude: house.mapPlacement.longitude,
          metersPerPlanUnit: house.mapPlacement.metersPerPlanUnit,
          ...(house.mapPlacement.footprintFloorId
            ? { footprintFloorPublicationId: remoteId("floor", house.mapPlacement.footprintFloorId) }
            : {}),
        } } : {}),
        ...(house.orientationDegrees !== undefined ? { orientationDegrees: house.orientationDegrees } : {}),
      } : null;
      const sensorCatalog: StugubySensorCatalogPayload = {
        publicationId: link.publicationId,
        sensors: this.database.listSensors(house.id).map((sensor) => ({
          sensorPublicationId: remoteId("sensor", sensor.id),
          floorPublicationId: remoteId("floor", sensor.floorId),
          ...(sensor.roomId ? { roomPublicationId: remoteId("room", sensor.roomId) } : {}),
          name: sensor.name,
          model: sensor.model,
          tags: sensor.tags.filter((tag) => tag !== "stuguby-shared"),
          enabled: sensor.enabled,
          x: sensor.x,
          y: sensor.y,
          z: sensor.z,
          metricIds: this.sensorMetrics(sensor.id),
        })),
      };
      const notes: StugubyHomeNotesPayload = {
        publicationId: link.publicationId,
        notes: this.database.listPropertyNotes({ houseId: house.id, limit: 10_000 }).map((note) => ({
          notePublicationId: remoteId("home-note", note.id),
          kind: note.kind,
          text: note.text,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        })),
      };
      const observations: StugubyHomeObservationsPayload = {
        publicationId: link.publicationId,
        observations: this.database.listObservations(house.id).map((observation) => ({
          observationPublicationId: remoteId("observation", observation.id),
          floorPublicationId: remoteId("floor", observation.floorId),
          ...(observation.sensorId ? { sensorPublicationId: remoteId("sensor", observation.sensorId) } : {}),
          kind: observation.kind,
          severity: observation.severity,
          note: observation.note,
          x: observation.x,
          y: observation.y,
          occurredAt: observation.occurredAt,
          ...(observation.timePrecision ? { timePrecision: observation.timePrecision } : {}),
          ...(observation.validFrom !== undefined ? { validFrom: observation.validFrom } : {}),
          ...(observation.validTo !== undefined ? { validTo: observation.validTo } : {}),
          ...(observation.confidence ? { confidence: observation.confidence } : {}),
          ...(observation.status ? { status: observation.status } : {}),
          ...(observation.resolutionNote !== undefined ? { resolutionNote: observation.resolutionNote } : {}),
          ...(observation.resolvedAt !== undefined ? { resolvedAt: observation.resolvedAt } : {}),
          updatedAt: observation.updatedAt ?? observation.createdAt,
        })),
      };
      const snapshot: StugubyHomeCommandSnapshot = {
        directory: { publicationId: link.publicationId, name: house.name, timezone: house.timezone },
        location,
        structure,
        sensorCatalog,
        notes,
        observations,
      };
      assertSafeFederationPayload(snapshot);
      return snapshot;
    },
  applyHomeCommandAs(this: StugubyServiceInternals, actorNodeId: string, candidate: unknown): StugubyHomeCommandResult {
      const command = validateHomeCommand(candidate);
      this.requireCoordinator(command.stugubyId);
      if (command.actorNodeId !== actorNodeId) {
        throw new StugubyError(403, "HOME_COMMAND_ACTOR_MISMATCH", "Home command actor does not match the authenticated node");
      }
      const actor = this.store.getMember(command.stugubyId, actorNodeId);
      if (!actor || actor.state !== "active" || actor.role === "viewer") {
        throw new StugubyError(403, "HOME_COMMAND_FORBIDDEN", "An active editing member is required");
      }
      const previous = this.store.getHomeCommand(command.id);
      if (previous?.result) return previous.result;
      const grant = this.store.getGrant(command.grantId);
      if (!grant || grant.stugubyId !== command.stugubyId || grant.authorityNodeId !== this.identity.nodeId
        || grant.publicationId !== command.publicationId || grant.epoch !== command.grantEpoch
        || grant.revokedAt || grantExpired(grant) || grant.housePolicy.editPolicy !== "editable"
        || !grantAudienceIncludes(grant, actorNodeId)) {
        throw new StugubyError(403, "HOME_COMMAND_NOT_AUTHORIZED", "The editable Home grant is inactive or does not include this member");
      }
      const house = this.database.getHouse(grant.localHouseId ?? "");
      if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "The authoritative Home was not found");
      const authorityEpoch = house.stuguby?.authorityEpoch ?? 1;
      if (command.authorityNodeId !== this.identity.nodeId || command.authorityEpoch !== authorityEpoch) {
        throw new StugubyError(409, "STALE_HOME_AUTHORITY", "The Home authority has changed; reload before editing");
      }
      this.store.enqueueHomeCommand(command);
      const currentRevision = this.store.homeRevision(command.stugubyId, this.identity.nodeId, command.publicationId);
      if (command.baseRevision !== currentRevision) {
        const result: StugubyHomeCommandResult = {
          commandId: command.id,
          status: "conflict",
          authorityRevision: currentRevision,
          message: "The Server kept its newer Home changes. Reload the Home before trying this edit again.",
        };
        this.store.completeHomeCommand(result);
        this.store.audit(command.stugubyId, "home.command.conflict", actorNodeId, command.publicationId, {
          commandId: command.id,
          baseRevision: command.baseRevision,
          authorityRevision: currentRevision,
        });
        return result;
      }
      try {
        return this.database.transaction(() => {
          this.applyEditableHomeSnapshot(command, house);
          const authoritative = this.database.getHouse(house.id)!;
          const revision = this.store.bumpHomeRevision(command.stugubyId, this.identity.nodeId, command.publicationId);
          const grants = this.store.listGrants(command.stugubyId, this.identity.nodeId)
            .filter((candidateGrant) => candidateGrant.localHouseId === house.id
              && !candidateGrant.revokedAt && !grantExpired(candidateGrant));
          for (const candidateGrant of grants) this.publishGrantSnapshots(candidateGrant, authoritative, revision);
          const result: StugubyHomeCommandResult = {
            commandId: command.id,
            status: "applied",
            authorityRevision: revision,
            message: "The Server accepted the shared Home changes.",
          };
          this.store.completeHomeCommand(result);
          this.store.audit(command.stugubyId, "home.command.applied", actorNodeId, command.publicationId, {
            commandId: command.id,
            revision,
          });
          return result;
        });
      } catch (error) {
        const result: StugubyHomeCommandResult = {
          commandId: command.id,
          status: "conflict",
          authorityRevision: currentRevision,
          message: error instanceof Error
            ? `The Server kept its Home because the shared edit could not be applied: ${error.message.slice(0, 300)}`
            : "The Server kept its Home because the shared edit could not be applied.",
        };
        this.store.completeHomeCommand(result);
        this.store.audit(command.stugubyId, "home.command.conflict", actorNodeId, command.publicationId, {
          commandId: command.id,
          reason: result.message,
        });
        return result;
      }
    },
});
