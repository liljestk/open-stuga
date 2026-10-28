import type { Property, StugubyHouseLink, StugubyPropertyAdoption, AreaEquipment, MaintenanceTask, PropertyArea, PropertyNote, StugubyPropertyLink, PropertyAreaKind } from "@climate-twin/contracts";
import { assertSafeFederationPayload, validateSharedProperty, type JsonValue, type StugubyShareGrant, type StugubySharedProperty, type StugubySummary, type JsonObject, type StugubyPropertyCommand, type StugubyPropertyEntityKind, validatePropertyCommand, type StugubyPropertyCommandResult, type StugubyPropertyConflict } from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import { SharedPropertyInput, StugubyError } from "../support/service-types.js";
import { requiredText, PROPERTY_AREA_KINDS } from "../support/federation-validation.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";
import { randomUUID } from "node:crypto";

declare module "../core.js" {
  interface StugubyServiceInternals {
    updateSharedProperty(stugubyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugubySharedProperty>;
    updateSharedPropertyAs(actorNodeId: string, stugubyId: string, baseRevision: number, input: SharedPropertyInput): StugubySharedProperty;
    adoptProperty(stugubyId: string, localPropertyId?: string): StugubyPropertyAdoption;
    migrateProperty(stugubyId: string, sourcePropertyId: string): {
            adoption: StugubyPropertyAdoption;
            migrationSnapshotId: string;
            moved: ReturnType<ClimateDatabase["migratePropertyInto"]>;
            createdGrants: StugubyShareGrant[];
        };
    detachProperty(stugubyId: string): StugubyPropertyAdoption;
    assertPropertyWriteAllowed(propertyId: string): void;
    capturePropertyMutation(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", value: JsonObject | null, changedFields?: string[]): StugubyPropertyCommand | null;
    captureCurrentPropertyEntity(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", changedFields?: string[]): StugubyPropertyCommand | null;
    enqueueCorePropertyMutation(
        stugubyId: string,
        entityKind: StugubyPropertyEntityKind,
        entityId: string,
        operation: "upsert" | "delete",
        value: JsonObject | null,
        changedFields?: string[],
      ): StugubyPropertyCommand;
    applyPropertyCommandAs(actorNodeId: string, candidate: unknown): StugubyPropertyCommandResult;
    publishSharedPropertyEvent(property: StugubySharedProperty): void;
    refreshPropertyLink(stugubyId: string, forcedState?: StugubyPropertyLink["syncState"]): void;
    registerLocalPropertyMappings(stuguby: StugubySummary, propertyId: string): void;
    sharedPropertyFromLocal(stugubyId: string, propertyId: string, previous: StugubySharedProperty): SharedPropertyInput;
    sharedArea(area: PropertyArea): StugubySharedProperty["areas"][number];
    sharedEquipment(stugubyId: string, item: AreaEquipment): StugubySharedProperty["equipment"][number];
    sharedNote(note: PropertyNote): StugubySharedProperty["notes"][number];
    sharedMaintenance(task: MaintenanceTask): StugubySharedProperty["maintenance"][number];
    materializeSharedProperty(shared: StugubySharedProperty): void;
  }

  interface StugubyServiceCore {
    updateSharedProperty(stugubyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugubySharedProperty>;
    updateSharedPropertyAs(actorNodeId: string, stugubyId: string, baseRevision: number, input: SharedPropertyInput): StugubySharedProperty;
    adoptProperty(stugubyId: string, localPropertyId?: string): StugubyPropertyAdoption;
    migrateProperty(stugubyId: string, sourcePropertyId: string): {
            adoption: StugubyPropertyAdoption;
            migrationSnapshotId: string;
            moved: ReturnType<ClimateDatabase["migratePropertyInto"]>;
            createdGrants: StugubyShareGrant[];
        };
    detachProperty(stugubyId: string): StugubyPropertyAdoption;
    assertPropertyWriteAllowed(propertyId: string): void;
    capturePropertyMutation(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", value: JsonObject | null, changedFields?: string[]): StugubyPropertyCommand | null;
    captureCurrentPropertyEntity(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", changedFields?: string[]): StugubyPropertyCommand | null;
    applyPropertyCommandAs(actorNodeId: string, candidate: unknown): StugubyPropertyCommandResult;
  }
}

registerStugubyServiceMethods({
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
  detachProperty(this: StugubyServiceInternals, stugubyId: string): StugubyPropertyAdoption {
      const adoption = this.store.getPropertyAdoption(stugubyId);
      if (!adoption || adoption.state !== "adopted") {
        throw new StugubyError(409, "PROPERTY_NOT_ADOPTED", "An adopted Stuguby Property was not found");
      }
      const property = this.database.getProperty(adoption.localPropertyId);
      const propertyLink = property?.stuguby;
      if (!property || !propertyLink) throw new StugubyError(409, "PROPERTY_PROJECTION_MISSING", "The adopted Property projection is missing");
      const detached = this.atomicPublication(() => {
        const now = new Date().toISOString();
        const cancelledPropertyCommands = this.store.cancelPendingPropertyCommands(stugubyId, now);
        const cancelledHomeCommands = this.store.cancelPendingHomeCommands(stugubyId, now);
        const adoptedLocalHouseIds = new Set(this.database.listHouses(property.id)
          .filter((house) => house.stuguby?.stugubyId === stugubyId && house.stuguby.ownership === "local")
          .map((house) => house.id));
        const localGrants = this.store.listGrants(stugubyId, this.identity.nodeId)
          .filter((grant) => !grant.revokedAt && typeof grant.localHouseId === "string"
            && adoptedLocalHouseIds.has(grant.localHouseId));
        for (const grant of localGrants) {
          this.store.discardOutboxGrantEpoch(stugubyId, grant.id, grant.epoch);
          const revoked = this.store.revokeGrant(grant.id);
          this.publishGrant({ ...revoked, audience: grant.audience }, "grant.revoked");
          this.store.retireLocalBlobReferences(stugubyId, grant.id, grant.epoch);
          this.store.audit(stugubyId, "grant.revoked", this.identity.nodeId, grant.id, {
            epoch: revoked.epoch,
            reason: "property-disconnected",
          }, now);
        }
        this.database.setPropertyStugubyLink(property.id, {
          ...propertyLink,
          editPolicy: "collaborative",
          syncState: "detached",
          pendingChangeCount: 0,
          detachedAt: now,
        });
        for (const house of this.database.listHouses(property.id)) {
          if (!house.stuguby || house.stuguby.stugubyId !== stugubyId) continue;
          if (house.stuguby.ownership === "local") {
            this.database.setHouseStugubyLink(house.id, null);
            continue;
          }
          const isReadySuccessor = house.stuguby.recoveryState === "ready"
            && house.stuguby.designatedSuccessorNodeId === this.identity.nodeId;
          if (isReadySuccessor) {
            this.promoteFullRecovery(stugubyId, house);
            this.database.setHouseStugubyLink(house.id, {
              ...house.stuguby,
              authorityNodeId: this.identity.nodeId,
              ownership: "local",
              editPolicy: "editable",
              syncState: "detached",
              authorityEpoch: house.stuguby.authorityEpoch + 1,
              pendingChangeCount: 0,
              conflictCount: 0,
              detachedAt: now,
            });
          } else {
            this.database.purgeSharedHouseProjection(house.id);
          }
        }
        const detached = this.store.detachProperty(stugubyId, now);
        this.store.audit(stugubyId, "property.detached", this.identity.nodeId, property.id, {
          cancelledPropertyCommands,
          cancelledHomeCommands,
          revokedLocalGrants: localGrants.length,
        }, now);
        return detached;
      });
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
      return detached;
    },
  assertPropertyWriteAllowed(this: StugubyServiceInternals, propertyId: string): void {
      const property = this.database.getProperty(propertyId);
      // Resource existence and its endpoint-specific error contract belong to
      // the caller. This guard only adds Stuguby authority policy.
      if (!property) return;
      if (!property.stuguby || property.stuguby.syncState === "detached") return;
      const stuguby = this.store.getStuguby(property.stuguby.stugubyId);
      if (!stuguby || stuguby.localMemberState !== "active") {
        throw new StugubyError(403, "MEMBERSHIP_INACTIVE", "An inactive Stuguby member cannot edit shared Property data");
      }
      if (property.stuguby.editPolicy === "read-only" && property.stuguby.authorityNodeId !== this.identity.nodeId) {
        throw new StugubyError(403, "PROPERTY_READ_ONLY", "The Stuguby coordinator has shared this Property as read-only");
      }
    },
  capturePropertyMutation(this: StugubyServiceInternals,
      propertyId: string,
      entityKind: StugubyPropertyEntityKind,
      entityId: string,
      operation: "upsert" | "delete",
      value: JsonObject | null,
      changedFields?: string[],
    ): StugubyPropertyCommand | null {
      const property = this.database.getProperty(propertyId);
      if (!property?.stuguby || property.stuguby.syncState === "detached") return null;
      const link = property.stuguby;
      this.assertPropertyWriteAllowed(propertyId);
      const remoteId = (
        resourceType: Exclude<StugubyPropertyEntityKind, "property">,
        localId: string,
      ): string => this.store.projectionRemoteId(
        link.stugubyId,
        link.authorityNodeId,
        resourceType,
        localId,
      );
      const sharedEntityId = entityKind === "property"
        ? link.stugubyId
        : remoteId(entityKind, entityId);
      const sharedValue = value ? { ...value } : null;
      const projectReference = (
        resourceType: "area" | "equipment",
        field: "areaId" | "equipmentId",
      ): void => {
        const localId = sharedValue?.[field];
        if (typeof localId === "string") sharedValue![field] = remoteId(resourceType, localId);
      };
      if (sharedValue && entityKind !== "property") {
        sharedValue.id = sharedEntityId;
        if (entityKind === "equipment") {
          projectReference("area", "areaId");
        } else if (entityKind === "note" || entityKind === "maintenance") {
          projectReference("area", "areaId");
          projectReference("equipment", "equipmentId");
        }
      }
      const projectedChangedFields = entityKind === "equipment" && changedFields
        ? [...new Set(changedFields.flatMap((field) => (
          field === "houseId"
            ? ["areaId", "home"]
            : field === "areaId"
              ? ["areaId", "home"]
              : [field]
        )))]
        : changedFields;
      return this.enqueueCorePropertyMutation(
        link.stugubyId,
        entityKind,
        sharedEntityId,
        operation,
        sharedValue,
        projectedChangedFields,
      );
    },
  captureCurrentPropertyEntity(this: StugubyServiceInternals,
      propertyId: string,
      entityKind: StugubyPropertyEntityKind,
      entityId: string,
      operation: "upsert" | "delete",
      changedFields?: string[],
    ): StugubyPropertyCommand | null {
      const propertyLink = this.database.getProperty(propertyId)?.stuguby;
      if (!propertyLink || propertyLink.syncState === "detached") return null;
      if (operation === "delete") {
        return this.capturePropertyMutation(propertyId, entityKind, entityId, "delete", null);
      }
      let value: JsonObject | null = null;
      if (entityKind === "property") {
        const property = this.database.getProperty(entityId);
        if (property) value = {
          name: property.name,
          description: property.description,
          location: property.location ? {
            latitude: property.location.latitude,
            longitude: property.location.longitude,
            ...(property.location.label ? { label: property.location.label } : {}),
          } : null,
        };
      } else if (entityKind === "area") {
        const area = this.database.getPropertyArea(entityId);
        if (area) value = this.sharedArea(area);
      } else if (entityKind === "equipment") {
        const equipment = this.database.getAreaEquipment(entityId);
        if (equipment) value = this.sharedEquipment(propertyLink.stugubyId, equipment);
      } else if (entityKind === "note") {
        const note = this.database.getPropertyNote(entityId);
        if (note) value = this.sharedNote(note);
      } else {
        const maintenance = this.database.getMaintenanceTask(entityId);
        if (maintenance) value = this.sharedMaintenance(maintenance);
      }
      if (!value) throw new StugubyError(404, "PROPERTY_ENTITY_NOT_FOUND", "The changed Property item was not found");
      return this.capturePropertyMutation(propertyId, entityKind, entityId, "upsert", value, changedFields);
    },
  enqueueCorePropertyMutation(this: StugubyServiceInternals,
      stugubyId: string,
      entityKind: StugubyPropertyEntityKind,
      entityId: string,
      operation: "upsert" | "delete",
      value: JsonObject | null,
      changedFields?: string[],
    ): StugubyPropertyCommand {
      const property = this.store.getSharedProperty(stugubyId);
      if (!property) throw new StugubyError(409, "SHARED_PROPERTY_NOT_READY", "Shared Property data is not available");
      const pending = this.store.pendingPropertyCommandFor(
        stugubyId,
        this.identity.nodeId,
        entityKind,
        entityId,
      );
      const nextFields = operation === "delete"
        ? []
        : [...new Set([...(pending?.command.changedFields ?? []),
          ...(changedFields ?? Object.keys(value ?? {}).filter((field) => field !== "id"))])];
      const command: StugubyPropertyCommand = {
        id: pending?.command.id ?? randomUUID(),
        stugubyId,
        actorNodeId: this.identity.nodeId,
        baseRevision: pending?.command.baseRevision ?? property.revision,
        entityKind,
        entityId,
        operation,
        changedFields: nextFields,
        value,
        createdAt: pending?.command.createdAt ?? new Date().toISOString(),
      };
      validatePropertyCommand(command);
      this.store.enqueuePropertyCommand(command);
      if (this.store.isCoordinator(stugubyId)) this.applyPropertyCommandAs(this.identity.nodeId, command);
      this.refreshPropertyLink(stugubyId);
      return command;
    },
  applyPropertyCommandAs(this: StugubyServiceInternals, actorNodeId: string, candidate: unknown): StugubyPropertyCommandResult {
      const command = validatePropertyCommand(candidate);
      if (command.actorNodeId !== actorNodeId) {
        throw new StugubyError(403, "PROPERTY_COMMAND_ACTOR_MISMATCH", "Property command actor does not match the authenticated node");
      }
      this.requireCoordinator(command.stugubyId);
      const actor = this.store.getMember(command.stugubyId, actorNodeId);
      const currentProperty = this.store.getSharedProperty(command.stugubyId);
      if (!actor || actor.state !== "active" || actor.role === "viewer" || !currentProperty) {
        throw new StugubyError(403, "PROPERTY_WRITE_FORBIDDEN", "This member cannot edit the shared Property");
      }
      if (actorNodeId !== this.identity.nodeId && currentProperty.editPolicy === "read-only") {
        throw new StugubyError(403, "PROPERTY_READ_ONLY", "The coordinator has shared this Property as read-only");
      }
      const previous = this.store.getPropertyCommand(command.id);
      if (previous?.result) return previous.result;
      if (!previous) this.store.enqueuePropertyCommand(command);

      const arrays: Record<Exclude<StugubyPropertyEntityKind, "property">, keyof Pick<StugubySharedProperty,
        "areas" | "equipment" | "notes" | "maintenance"
      >> = {
        area: "areas",
        equipment: "equipment",
        note: "notes",
        maintenance: "maintenance",
      };
      const allowedFields: Record<StugubyPropertyEntityKind, readonly string[]> = {
        property: ["name", "description", "location"],
        area: ["name", "kind", "description", "location", "polygon"],
        equipment: ["areaId", "home", "location", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes"],
        note: ["areaId", "equipmentId", "kind", "text", "createdAt", "updatedAt"],
        maintenance: ["title", "description", "areaId", "equipmentId", "state", "dueAt", "completedAt", "createdAt", "updatedAt"],
      };
      if (command.entityKind === "property" && command.entityId !== command.stugubyId) {
        throw new StugubyError(400, "INVALID_PROPERTY_COMMAND", "Property commands must target the Stuguby id");
      }
      if (command.changedFields.some((field) => !allowedFields[command.entityKind].includes(field))) {
        throw new StugubyError(400, "INVALID_PROPERTY_COMMAND", "Property command contains unsupported fields");
      }

      const currentValue = command.entityKind === "property"
        ? {
          name: currentProperty.name,
          description: currentProperty.description,
          location: currentProperty.location,
        } as JsonObject
        : (currentProperty[arrays[command.entityKind]] as unknown as JsonObject[])
          .find((item) => item.id === command.entityId) ?? null;
      const fieldRevisions = this.store.propertyFieldRevisions(command.stugubyId, command.entityKind, command.entityId);
      const consideredFields = command.operation === "delete"
        ? Object.keys(currentValue ?? {}).filter((field) => field !== "id")
        : command.changedFields;
      const conflictingFields = consideredFields.filter((field) => (fieldRevisions[field] ?? 1) > command.baseRevision);
      const appliedFields = command.operation === "delete"
        ? (conflictingFields.length === 0 ? consideredFields : [])
        : command.changedFields.filter((field) => !conflictingFields.includes(field));
      const detectedAt = new Date().toISOString();
      const conflict: StugubyPropertyConflict | null = conflictingFields.length > 0 ? {
        commandId: command.id,
        entityKind: command.entityKind,
        entityId: command.entityId,
        fields: conflictingFields,
        message: `The Server kept its newer ${command.entityKind} value for ${conflictingFields.join(", ")}.`,
        serverValue: currentValue,
        clientValue: command.value,
        detectedAt,
        resolvedAt: null,
      } : null;

      let next = structuredClone(currentProperty);
      let changed = false;
      if (command.operation === "delete") {
        if (currentValue && conflictingFields.length === 0 && command.entityKind !== "property") {
          const key = arrays[command.entityKind];
          (next[key] as unknown as JsonObject[]) = (next[key] as unknown as JsonObject[])
            .filter((item) => item.id !== command.entityId);
          changed = true;
        }
      } else if (appliedFields.length > 0 && command.value) {
        if (command.entityKind === "property") {
          const writable = next as unknown as Record<string, JsonValue>;
          for (const field of appliedFields) writable[field] = command.value[field]!;
        } else {
          const key = arrays[command.entityKind];
          const items = next[key] as unknown as JsonObject[];
          const index = items.findIndex((item) => item.id === command.entityId);
          const entity: JsonObject = index >= 0 ? { ...items[index]! } : { id: command.entityId };
          for (const field of appliedFields) entity[field] = command.value[field]!;
          if (index >= 0) items[index] = entity;
          else items.push(entity);
        }
        changed = true;
      }

      if (changed) {
        next.revision = currentProperty.revision + 1;
        next.updatedAt = detectedAt;
        validateSharedProperty(next);
      }
      const result: StugubyPropertyCommandResult = {
        commandId: command.id,
        status: conflict ? "conflict" : "applied",
        appliedFields,
        conflict,
        property: changed ? next : currentProperty,
      };
      const completed = this.atomicPublication(() => {
        if (changed) {
          this.store.saveSharedProperty(next, currentProperty.revision);
          this.store.setPropertyFieldRevisions(command.stugubyId, command.entityKind, command.entityId,
            command.operation === "delete" ? consideredFields : appliedFields, next.revision);
          this.publishSharedPropertyEvent(next);
        }
        this.store.completePropertyCommand(result);
        this.store.audit(command.stugubyId, conflict ? "property.command.conflict" : "property.command.applied",
          actorNodeId, command.entityId, {
            commandId: command.id,
            entityKind: command.entityKind,
            appliedFields: appliedFields.length,
            conflictFields: conflictingFields.length,
            revision: result.property.revision,
          }, detectedAt);
        return result;
      });
      this.materializeSharedProperty(completed.property);
      return completed;
    },
  publishSharedPropertyEvent(this: StugubyServiceInternals, property: StugubySharedProperty): void {
      const event = this.createEvent({
        stugubyId: property.stugubyId,
        eventKind: "shared-property.updated",
        streamId: "shared-property",
        schema: "stuguby.shared-property.v2",
        resourceId: property.stugubyId,
        operation: "upsert",
        revision: property.revision,
        grantId: null,
        grantEpoch: null,
        payload: property,
      });
      this.distribute(event);
    },
  refreshPropertyLink(this: StugubyServiceInternals, stugubyId: string, forcedState?: StugubyPropertyLink["syncState"]): void {
      const adoption = this.store.getPropertyAdoption(stugubyId);
      const shared = this.store.getSharedProperty(stugubyId);
      const stuguby = this.store.getStuguby(stugubyId);
      if (!adoption || adoption.state !== "adopted" || !shared || !stuguby) return;
      const counts = this.store.propertyCommandCounts(stugubyId);
      const syncState = forcedState ?? (counts.conflicts > 0 ? "conflict" : counts.pending > 0 ? "pending" : "current");
      this.database.setPropertyStugubyLink(adoption.localPropertyId, {
        stugubyId,
        authorityNodeId: stuguby.coordinatorNodeId,
        isAuthority: stuguby.coordinatorNodeId === this.identity.nodeId,
        editPolicy: shared.editPolicy,
        syncState,
        authorityEpoch: shared.authorityEpoch,
        lastSyncedRevision: shared.revision,
        pendingChangeCount: counts.pending,
        conflictCount: this.store.listPropertyConflicts(stugubyId).length,
      });
    },
  registerLocalPropertyMappings(this: StugubyServiceInternals, stuguby: StugubySummary, propertyId: string): void {
      for (const area of this.database.listPropertyAreas(propertyId)) {
        this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "area", area.id, area.id);
      }
      for (const item of this.database.listAreaEquipment({ propertyId })) {
        this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "equipment", item.id, item.id);
      }
      for (const note of this.database.listPropertyNotes({ propertyId })) {
        this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "note", note.id, note.id);
      }
      for (const task of this.database.listMaintenanceTasks({ propertyId })) {
        this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "maintenance", task.id, task.id);
      }
    },
  sharedPropertyFromLocal(this: StugubyServiceInternals, stugubyId: string, propertyId: string, previous: StugubySharedProperty): SharedPropertyInput {
      const property = this.database.getProperty(propertyId);
      if (!property) throw new StugubyError(404, "PROPERTY_NOT_FOUND", "Local Property was not found");
      return {
        name: property.name,
        description: property.description,
        location: property.location ? {
          latitude: property.location.latitude,
          longitude: property.location.longitude,
          ...(property.location.label ? { label: property.location.label } : {}),
        } : null,
        areas: this.database.listPropertyAreas(propertyId).map((area) => this.sharedArea(area)),
        equipment: this.database.listAreaEquipment({ propertyId }).map((item) => this.sharedEquipment(stugubyId, item)),
        notes: this.database.listPropertyNotes({ propertyId }).map((note) => this.sharedNote(note)),
        maintenance: this.database.listMaintenanceTasks({ propertyId }).map((task) => this.sharedMaintenance(task)),
        editPolicy: previous.editPolicy,
        designatedSuccessorNodeId: previous.designatedSuccessorNodeId,
      };
    },
  sharedArea(this: StugubyServiceInternals, area: PropertyArea): StugubySharedProperty["areas"][number] {
      return {
        id: area.id,
        name: area.name,
        kind: area.kind,
        description: area.description,
        ...(area.location ? { location: { latitude: area.location.latitude, longitude: area.location.longitude } } : {}),
        polygon: area.polygon.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
      } as unknown as StugubySharedProperty["areas"][number];
    },
  sharedEquipment(this: StugubyServiceInternals, stugubyId: string, item: AreaEquipment): StugubySharedProperty["equipment"][number] {
      const house = item.houseId ? this.database.getHouse(item.houseId) : null;
      let home: StugubySharedProperty["equipment"][number]["home"] = null;
      if (house) {
        const authorityNodeId = house.stuguby?.stugubyId === stugubyId
          ? house.stuguby.authorityNodeId
          : this.identity.nodeId;
        const publicationId = house.stuguby?.stugubyId === stugubyId
          ? house.stuguby.publicationId
          : this.store.publicationId(stugubyId, "home", house.id);
        this.store.projectionId(stugubyId, authorityNodeId, "home", publicationId, house.id);
        home = { authorityNodeId, publicationId };
      }
      return {
        id: item.id,
        areaId: item.areaId,
        home,
        ...(item.location ? {
          location: {
            latitude: item.location.latitude,
            longitude: item.location.longitude,
          },
        } : {}),
        name: item.name,
        kind: item.kind,
        manufacturer: item.manufacturer,
        model: item.model,
        serialNumber: item.serialNumber,
        status: item.status,
        notes: item.notes,
      };
    },
  sharedNote(this: StugubyServiceInternals, note: PropertyNote): StugubySharedProperty["notes"][number] {
      return {
        id: note.id,
        areaId: note.areaId,
        equipmentId: note.equipmentId,
        kind: note.kind,
        text: note.text,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
    },
  sharedMaintenance(this: StugubyServiceInternals, task: MaintenanceTask): StugubySharedProperty["maintenance"][number] {
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        areaId: task.areaId ?? null,
        equipmentId: task.equipmentId ?? null,
        state: task.status === "completed" || task.status === "verified" ? "done" : task.status,
        dueAt: task.dueBy ? `${task.dueBy}T23:59:59.000Z` : null,
        completedAt: task.completedAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    },
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
});
