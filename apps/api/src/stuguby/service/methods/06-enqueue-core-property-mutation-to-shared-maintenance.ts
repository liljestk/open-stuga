import { randomUUID } from "node:crypto";
import type {
  AreaEquipment,
  MaintenanceTask,
  PropertyArea,
  PropertyNote,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  validatePropertyCommand,
  validateSharedProperty,
  type JsonObject,
  type JsonValue,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubySharedProperty,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { SharedPropertyInput, StugubyError } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
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
});
