import type { Floor, House, StugubyHomeProjection } from "@climate-twin/contracts";
import type { JsonObject, StugubyHomeRecoveryKind, StugubyHomeRecoveryPayload, StugubyDataset, StugubyHomeDirectoryPayload, StugubyHomeFloorPlanPayload, StugubyHomeLocationPayload, StugubyHomeNotesPayload, StugubyHomeObservationsPayload, StugubyHomeStructurePayload, StugubySensorCatalogPayload } from "@climate-twin/stuguby-protocol";
import { StugubyError } from "../support/service-types.js";
import { grantAudienceIncludes, grantExpired, recoveryAssetReferences } from "../support/federation-validation.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";
import { peerObservation } from "../../peer-observation.js";
import { compareCodeUnits } from "../../../text-order.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    promoteFullRecovery(stugubyId: string, house: House): void;
    materializeAllRemoteHomes(stugubyId: string): void;
    removeRemoteHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): void;
    materializeRemoteHome(stugubyId: string, authorityNodeId: string, publicationId: string): void;
  }
}

registerStugubyServiceMethods({
  promoteFullRecovery(this: StugubyServiceInternals, stugubyId: string, house: House): void {
      const link = house.stuguby;
      if (!link) throw new StugubyError(409, "RECOVERY_LINK_MISSING", "The Home recovery link is missing");
      const payloads = this.store.listRemoteResources(stugubyId)
        .filter((resource) => resource.authorityNodeId === link.authorityNodeId
          && resource.publicationId === link.publicationId
          && resource.schema === "home.recovery.v1")
        .map((resource) => resource.payload as unknown as StugubyHomeRecoveryPayload);
      const generation = Math.max(0, ...payloads.map((payload) => payload.generation));
      const current = payloads.filter((payload) => payload.generation === generation);
      const records = (kind: StugubyHomeRecoveryKind): JsonObject[] => current
        .filter((payload) => payload.kind === kind)
        .flatMap((payload) => payload.records);
      const projectionMap = (type: "floor" | "room" | "plan-element" | "sensor") => new Map(
        this.store.listProjectionIds(stugubyId, link.authorityNodeId, type)
          .map((projection) => [projection.remoteId, projection.localId]),
      );
      const floorIds = projectionMap("floor");
      const roomIds = projectionMap("room");
      const elementIds = projectionMap("plan-element");
      const sensorIds = projectionMap("sensor");

      this.database.transaction(() => {
        for (const definition of records("measurement-definitions")) {
          const id = String(definition.id);
          if (this.database.getMeasurementDefinition(id)) continue;
          this.database.createMeasurementDefinition({
            id,
            labels: definition.labels as Record<string, string>,
            unit: String(definition.unit),
            ...(typeof definition.dimension === "string" ? { dimension: definition.dimension } : {}),
            ...(Array.isArray(definition.allowedUnits) ? { allowedUnits: definition.allowedUnits as string[] } : {}),
            ...(typeof definition.kind === "string" ? { kind: definition.kind as never } : {}),
            ...(typeof definition.defaultAggregation === "string"
              ? { defaultAggregation: definition.defaultAggregation as never }
              : {}),
            genericHistoryEnabled: true,
            genericStatsEnabled: true,
            precision: Number(definition.precision),
            validMin: definition.validMin === null ? null : Number(definition.validMin),
            validMax: definition.validMax === null ? null : Number(definition.validMax),
            displayMin: definition.displayMin === null ? null : Number(definition.displayMin),
            displayMax: definition.displayMax === null ? null : Number(definition.displayMax),
            interpolationDelta: Number(definition.interpolationDelta),
            colorScale: definition.colorScale as never,
            builtin: false,
            enabled: Boolean(definition.enabled),
            spatialInterpolation: Boolean(definition.spatialInterpolation),
            forecastSupported: Boolean(definition.forecastSupported),
          });
        }

        const restoredRules = new Map<string, string>();
        for (const rule of records("alert-rules")) {
          const sensorId = sensorIds.get(String(rule.sensorPublicationId));
          if (!sensorId || !this.database.getMeasurementDefinition(String(rule.metric))) continue;
          const restored = this.database.saveAlertRule({
            name: String(rule.name),
            sensorId,
            metric: String(rule.metric),
            operator: rule.operator as never,
            threshold: Number(rule.threshold),
            durationSeconds: Number(rule.durationSeconds),
            severity: rule.severity as never,
            enabled: Boolean(rule.enabled),
            webhookEnabled: false,
            telegramEnabled: false,
          });
          restoredRules.set(String(rule.ruleKey), restored.id);
          if (rule.retiredAt) this.database.deleteAlertRule(restored.id);
        }
        const insertAlert = this.database.db.prepare(`INSERT OR IGNORE INTO alert_events
          (id,rule_id,sensor_id,metric,value,threshold,severity,started_at,acknowledged_at,resolved_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        for (const event of records("alert-events")) {
          const ruleId = restoredRules.get(String(event.ruleKey));
          const sensorId = sensorIds.get(String(event.sensorPublicationId));
          if (!ruleId || !sensorId) continue;
          insertAlert.run(
            String(event.eventKey),
            ruleId,
            sensorId,
            String(event.metric),
            Number(event.value),
            Number(event.threshold),
            String(event.severity),
            String(event.startedAt),
            event.acknowledgedAt === null ? null : String(event.acknowledgedAt),
            event.resolvedAt === null ? null : String(event.resolvedAt),
          );
        }

        for (const parameter of records("static-parameters")) {
          const scopeType = String(parameter.scopeType) as "house" | "floor" | "room" | "sensor";
          const remoteScopeId = String(parameter.scopePublicationId);
          const scopeId = scopeType === "house"
            ? house.id
            : scopeType === "floor"
              ? floorIds.get(remoteScopeId)
              : scopeType === "room"
                ? roomIds.get(remoteScopeId)
                : sensorIds.get(remoteScopeId);
          if (!scopeId) continue;
          this.database.saveParameter({
            houseId: house.id,
            scopeType,
            scopeId,
            key: String(parameter.key),
            value: parameter.value as string | number | boolean,
            unit: parameter.unit === null ? null : String(parameter.unit),
            label: String(parameter.label),
          });
        }

        for (const opening of records("opening-states")) {
          const floorId = floorIds.get(String(opening.floorPublicationId));
          const elementId = elementIds.get(String(opening.planElementPublicationId));
          if (!floorId || !elementId) continue;
          this.database.recordOpeningStateObservation(house.id, {
            floorId,
            elementId,
            state: opening.state as never,
            ...(opening.openFraction !== null ? { openFraction: Number(opening.openFraction) } : {}),
            source: "api",
            observedAt: String(opening.observedAt),
            ...(opening.validUntil ? { validUntil: String(opening.validUntil) } : {}),
          });
        }

        this.database.db.prepare("DELETE FROM outdoor_temperature_samples WHERE house_id=?").run(house.id);
        const insertWeather = this.database.db.prepare(`INSERT OR IGNORE INTO outdoor_temperature_samples
          (house_id,location_key,timestamp,temperature_c,source,fetched_at,station_id,station_name,conditions_json)
          VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const weather of records("weather-history")) {
          insertWeather.run(
            house.id,
            String(weather.locationKey),
            String(weather.timestamp),
            Number(weather.temperatureC),
            String(weather.source),
            String(weather.fetchedAt),
            weather.stationId === null ? null : String(weather.stationId),
            weather.stationName === null ? null : String(weather.stationName),
            weather.conditions === null ? null : JSON.stringify(weather.conditions),
          );
        }
        const insertPrice = this.database.db.prepare(`INSERT INTO electricity_price_points
          (property_id,start_at,end_at,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(property_id,start_at) DO UPDATE SET
            end_at=excluded.end_at,raw_price_cents_per_kwh=excluded.raw_price_cents_per_kwh,
            margin_cents_per_kwh=excluded.margin_cents_per_kwh,fetched_at=excluded.fetched_at`);
        for (const price of records("electricity-history")) {
          insertPrice.run(
            house.propertyId,
            String(price.startAt),
            String(price.endAt),
            Number(price.rawPriceCentsPerKwh),
            Number(price.marginCentsPerKwh),
            String(price.fetchedAt),
          );
        }
        this.database.db.prepare("DELETE FROM assets WHERE house_id=?").run(house.id);
        const insertAsset = this.database.db.prepare(`INSERT INTO assets
          (id,house_id,name,mime_type,kind,data,size,created_at) VALUES (?,?,?,?,?,?,?,?)`);
        for (const asset of records("assets")) {
          const digest = String(asset.digest);
          const blob = this.readBlob(digest);
          if (blob.data.byteLength !== Number(asset.byteLength) || blob.mediaType !== String(asset.mimeType)) {
            throw new StugubyError(409, "RECOVERY_ASSET_INCOMPLETE", `Home asset ${String(asset.name)} is incomplete`);
          }
          const localId = this.store.projectionId(
            stugubyId,
            link.authorityNodeId,
            "asset",
            String(asset.assetKey),
          );
          insertAsset.run(
            localId,
            house.id,
            String(asset.name),
            String(asset.mimeType),
            String(asset.kind),
            blob.data,
            blob.data.byteLength,
            String(asset.createdAt),
          );
        }
        this.store.promoteRecoveryTelemetry(stugubyId, link.authorityNodeId, link.publicationId);
      });
      this.store.audit(stugubyId, "home.recovery.promoted", this.identity.nodeId, link.publicationId, {
        generation,
        integrationsTransferred: false,
      });
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
  removeRemoteHomeProjection(
      this: StugubyServiceInternals,
      stugubyId: string,
      authorityNodeId: string,
      publicationId: string,
    ): void {
      const projection = this.store.getHomeProjection(stugubyId, authorityNodeId, publicationId);
      const localHouseId = projection?.localHouseId
        ?? this.store.projectionId(stugubyId, authorityNodeId, "home", publicationId);
      const house = this.database.getHouse(localHouseId);
      const projectionIds = house ? [
        { resourceType: "home" as const, localId: house.id },
        ...house.floors.flatMap((floor) => [
          { resourceType: "floor" as const, localId: floor.id },
          ...floor.rooms.map((room) => ({ resourceType: "room" as const, localId: room.id })),
          ...floor.walls.map((wall) => ({ resourceType: "wall" as const, localId: wall.id })),
          ...(floor.planElements ?? [])
            .map((element) => ({ resourceType: "plan-element" as const, localId: element.id })),
        ]),
        ...this.database.listSensors(house.id)
          .map((sensor) => ({ resourceType: "sensor" as const, localId: sensor.id })),
        ...this.store.listProjectionIds(stugubyId, authorityNodeId, "home-note")
          .filter((item) => this.database.getPropertyNote(item.localId)?.houseId === house.id)
          .map((item) => ({ resourceType: "home-note" as const, localId: item.localId })),
        ...this.store.listProjectionIds(stugubyId, authorityNodeId, "observation")
          .filter((item) => this.database.getObservation(item.localId)?.houseId === house.id)
          .map((item) => ({ resourceType: "observation" as const, localId: item.localId })),
      ] : [{ resourceType: "home" as const, localId: localHouseId }];
      if (house?.stuguby?.ownership === "shared"
        && house.stuguby.syncState !== "detached"
        && house.stuguby.stugubyId === stugubyId
        && house.stuguby.authorityNodeId === authorityNodeId
        && house.stuguby.publicationId === publicationId) {
        this.database.purgeSharedHouseProjection(house.id);
      }
      this.store.removeHomeProjection(stugubyId, authorityNodeId, publicationId);
      this.store.removeProjectionIds(stugubyId, authorityNodeId, projectionIds);
    },
  materializeRemoteHome(this: StugubyServiceInternals, stugubyId: string, authorityNodeId: string, publicationId: string): void {
      const adoption = this.store.getPropertyAdoption(stugubyId);
      if (!adoption || adoption.state !== "adopted") {
        this.removeRemoteHomeProjection(stugubyId, authorityNodeId, publicationId);
        return;
      }
      const grant = this.store.listGrants(stugubyId, authorityNodeId)
        .find((item) => item.publicationId === publicationId
          && !item.revokedAt
          && !grantExpired(item)
          && grantAudienceIncludes(item, this.identity.nodeId));
      if (!grant) {
        this.removeRemoteHomeProjection(stugubyId, authorityNodeId, publicationId);
        return;
      }
      const resources = this.store.listRemoteResources(stugubyId)
        .filter((resource) => resource.authorityNodeId === authorityNodeId && resource.publicationId === publicationId);
      const bySchema = new Map(resources.map((resource) => [resource.schema, resource]));
      const directory = bySchema.get("home.directory.v1")?.payload as unknown as StugubyHomeDirectoryPayload | undefined;
      if (!directory) {
        this.removeRemoteHomeProjection(stugubyId, authorityNodeId, publicationId);
        return;
      }

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
          location: location ?? null,
          mapPlacement: mapPlacement ?? null,
          orientationDegrees: locationPayload?.orientationDegrees ?? null,
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
      const expectedSensorIds = new Set<string>();
      if (sensorCatalog) {
        for (const item of sensorCatalog.sensors) {
          const floorId = floorIds.get(item.floorPublicationId);
          if (!floorId) continue;
          const id = this.store.projectionId(stugubyId, authorityNodeId, "sensor", item.sensorPublicationId);
          expectedSensorIds.add(id);
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
      }
      for (const sensor of this.database.listSensors(house.id)) {
        if (sensor.tags.includes("stuguby-shared") && !expectedSensorIds.has(sensor.id)) {
          this.database.deleteSensor(sensor.id);
        }
      }

      const notesPayload = bySchema.get("home.notes.v1")?.payload as unknown as StugubyHomeNotesPayload | undefined;
      const expectedNoteIds = new Set<string>();
      if (notesPayload) {
        for (const item of notesPayload.notes) {
          const id = this.store.projectionId(stugubyId, authorityNodeId, "home-note", item.notePublicationId);
          expectedNoteIds.add(id);
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
      }
      for (const projection of this.store.listProjectionIds(stugubyId, authorityNodeId, "home-note")) {
        const note = this.database.getPropertyNote(projection.localId);
        if (note?.houseId === house.id && !expectedNoteIds.has(projection.localId)) {
          this.database.deletePropertyNote(projection.localId);
        }
      }

      const observationsPayload = bySchema.get("home.observations.v1")?.payload as unknown as StugubyHomeObservationsPayload | undefined;
      const expectedObservationIds = new Set<string>();
      if (observationsPayload) {
        for (const item of observationsPayload.observations) {
          const floorId = floorIds.get(item.floorPublicationId);
          if (!floorId) continue;
          const sensorId = item.sensorPublicationId
            ? this.store.projectionId(stugubyId, authorityNodeId, "sensor", item.sensorPublicationId)
            : null;
          if (sensorId && !this.database.getSensor(sensorId)) continue;
          const observation = peerObservation(item);
          if (!observation) continue;
          const id = this.store.projectionId(stugubyId, authorityNodeId, "observation", item.observationPublicationId);
          expectedObservationIds.add(id);
          const existing = this.database.getObservation(id);
          if (!existing) {
            this.database.createObservation({
              id,
              houseId: house.id,
              floorId,
              sensorId,
              ...observation.content,
              source: "unknown",
              sourceDetail: "Stuguby shared history",
            }, "system-service");
          } else {
            this.database.updateObservation(id, {
              baseRevision: existing.revision,
              floorId,
              sensorId,
              ...observation.content,
              ...observation.lifecycle,
            }, "system-service");
          }
        }
      }
      for (const projection of this.store.listProjectionIds(stugubyId, authorityNodeId, "observation")) {
        const observation = this.database.getObservation(projection.localId);
        if (observation?.houseId === house.id && !expectedObservationIds.has(projection.localId)) {
          this.database.deleteObservation(projection.localId);
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
      const syncedThrough = resources.map((resource) => resource.receivedAt).sort(compareCodeUnits).at(-1) ?? null;
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
