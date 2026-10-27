import type {
  Floor,
  House,
} from "@climate-twin/contracts";
import {
  type JsonObject,
  type StugubyHomeCommand,
  type StugubyPropertyCommand,
  type StugubyPropertyEntityKind,
} from "@climate-twin/stuguby-protocol";
import { StugubyError } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  applyEditableHomeSnapshot(this: StugubyServiceInternals, command: StugubyHomeCommand, house: House): void {
      const snapshot = command.snapshot;
      const localId = (
        type: "floor" | "room" | "wall" | "plan-element" | "sensor" | "note" | "observation",
        publicationId: string,
      ) => this.store.publicationLocalId(command.stugubyId, this.identity.nodeId, type, publicationId, true)!;
      const currentFloorById = new Map(house.floors.map((floor) => [floor.id, floor]));
      const floorIds = new Map<string, string>();
      const roomIds = new Map<string, string>();
      const floors: Floor[] = snapshot.structure.floors.map((floor) => {
        const floorId = localId("floor", floor.floorPublicationId);
        floorIds.set(floor.floorPublicationId, floorId);
        const wallIds = new Map(floor.walls.map((wall) => [wall.wallPublicationId, localId("wall", wall.wallPublicationId)]));
        const existingFloor = currentFloorById.get(floorId);
        const existingElements = new Map((existingFloor?.planElements ?? []).map((element) => [element.id, element]));
        const rooms = floor.rooms.map((room) => {
          const roomId = localId("room", room.roomPublicationId);
          roomIds.set(room.roomPublicationId, roomId);
          return {
            id: roomId,
            name: room.name,
            points: room.points.map((point) => ({ x: point.x, y: point.y })),
            ...(room.kind ? { kind: room.kind } : {}),
          };
        });
        const planElements = floor.planElements.flatMap((element) => {
          const id = localId("plan-element", element.planElementPublicationId);
          const projected: Record<string, unknown> = {
            id,
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
          const existingElement = existingElements.get(id);
          if (existingElement && "stateBinding" in existingElement && existingElement.stateBinding) {
            projected.stateBinding = existingElement.stateBinding;
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
        if (existingFloor?.backgroundImage) projected.backgroundImage = existingFloor.backgroundImage;
        return projected as unknown as Floor;
      });

      const incomingFloorIds = new Set(floors.map((floor) => floor.id));
      const transitionalFloors = [...floors, ...house.floors.filter((floor) => !incomingFloorIds.has(floor.id))];
      const locationPayload = snapshot.location;
      const location = locationPayload ? {
        latitude: locationPayload.latitude,
        longitude: locationPayload.longitude,
        ...(locationPayload.label ? { label: locationPayload.label } : {}),
        ...(locationPayload.countryCode ? { countryCode: locationPayload.countryCode } : {}),
        source: "manual" as const,
      } : null;
      const footprintFloorId = locationPayload?.mapPlacement?.footprintFloorPublicationId
        ? floorIds.get(locationPayload.mapPlacement.footprintFloorPublicationId)
        : undefined;
      const mapPlacement = locationPayload?.mapPlacement ? {
        latitude: locationPayload.mapPlacement.latitude,
        longitude: locationPayload.mapPlacement.longitude,
        metersPerPlanUnit: locationPayload.mapPlacement.metersPerPlanUnit,
        ...(footprintFloorId ? { footprintFloorId } : {}),
      } : null;
      this.database.updateHouse(house.id, {
        name: snapshot.directory.name,
        timezone: snapshot.directory.timezone,
        location,
        mapPlacement,
        orientationDegrees: locationPayload?.orientationDegrees ?? null,
        floors: transitionalFloors,
      }, "system-service");

      const expectedSensors = new Set<string>();
      for (const item of snapshot.sensorCatalog.sensors) {
        const floorId = floorIds.get(item.floorPublicationId);
        if (!floorId) throw new Error(`Sensor ${item.sensorPublicationId} references an unknown floor`);
        const id = localId("sensor", item.sensorPublicationId);
        expectedSensors.add(id);
        const roomId = item.roomPublicationId ? roomIds.get(item.roomPublicationId) ?? null : null;
        const room = roomId
          ? floors.find((floor) => floor.id === floorId)?.rooms.find((candidate) => candidate.id === roomId)?.name ?? ""
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
            tags: item.tags.filter((tag) => tag !== "stuguby-shared"),
            enabled: item.enabled,
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
            tags: item.tags.filter((tag) => tag !== "stuguby-shared"),
            enabled: item.enabled,
          });
        }
      }

      const expectedObservations = new Set<string>();
      for (const item of snapshot.observations.observations) {
        const floorId = floorIds.get(item.floorPublicationId);
        if (!floorId) throw new Error(`Observation ${item.observationPublicationId} references an unknown floor`);
        const sensorId = item.sensorPublicationId ? localId("sensor", item.sensorPublicationId) : null;
        if (sensorId && !this.database.getSensor(sensorId)) throw new Error(`Observation ${item.observationPublicationId} references an unknown sensor`);
        const id = localId("observation", item.observationPublicationId);
        expectedObservations.add(id);
        const existing = this.database.getObservation(id);
        if (!existing) {
          const created = this.database.createObservation({
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
            sourceDetail: `Shared edit from ${command.actorNodeId}`,
            ...(item.confidence ? { confidence: item.confidence as never } : {}),
          }, "system-service");
          if (item.status === "resolved") {
            this.database.updateObservation(id, {
              baseRevision: created.revision ?? 1,
              status: "resolved",
              resolutionNote: item.resolutionNote ?? "Resolved in shared Home",
            }, "system-service");
          }
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
      for (const existing of this.database.listObservations(house.id)) {
        if (!expectedObservations.has(existing.id)) this.database.deleteObservation(existing.id);
      }
      for (const existing of this.database.listSensors(house.id)) {
        if (!expectedSensors.has(existing.id)) this.database.deleteSensor(existing.id);
      }

      const expectedNotes = new Set<string>();
      for (const item of snapshot.notes.notes) {
        const id = localId("note", item.notePublicationId);
        expectedNotes.add(id);
        const existing = this.database.getPropertyNote(id);
        if (existing) {
          this.database.updatePropertyNote(id, {
            houseId: house.id,
            areaId: null,
            equipmentId: null,
            kind: item.kind,
            text: item.text,
          });
        } else {
          this.database.createPropertyNote({
            id,
            propertyId: house.propertyId,
            houseId: house.id,
            areaId: null,
            equipmentId: null,
            kind: item.kind,
            text: item.text,
          });
        }
      }
      for (const existing of this.database.listPropertyNotes({ houseId: house.id, limit: 10_000 })) {
        if (!expectedNotes.has(existing.id)) this.database.deletePropertyNote(existing.id);
      }
      if (transitionalFloors.length !== floors.length) {
        this.database.updateHouse(house.id, { floors }, "system-service");
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
});
