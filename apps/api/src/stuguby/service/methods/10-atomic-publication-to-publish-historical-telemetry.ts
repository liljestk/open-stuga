import type {
  House,
} from "@climate-twin/contracts";
import {
  assertSafeFederationPayload,
  type JsonValue,
  type StugubyDatasetGrant,
  type StugubyHomeDirectoryPayload,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeLocationPayload,
  type StugubyHomeNotesPayload,
  type StugubyHomeObservationsPayload,
  type StugubyHomeStructurePayload,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
  type StugubyTelemetryPayload,
} from "@climate-twin/stuguby-protocol";
import { Notification, StugubyError, asJson, parseIso, sha256 } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  atomicPublication<T>(this: StugubyServiceInternals, operation: () => T): T {
      if (this[stugubyServiceState].deferredNotifications) return operation();
      const notifications: Notification[] = [];
      this[stugubyServiceState].deferredNotifications = notifications;
      try {
        const result = this.database.transaction(operation);
        for (const notification of notifications) this[stugubyServiceState].notifications.emit("event", notification);
        return result;
      } finally {
        this[stugubyServiceState].deferredNotifications = null;
      }
    },
  publishGrantSnapshots(this: StugubyServiceInternals,
      grant: StugubyShareGrant,
      house: House,
      revision = this.store.homeRevision(grant.stugubyId, this.identity.nodeId, grant.publicationId),
    ): void {
      let recoveryTelemetrySamples = 0;
      for (const dataset of grant.datasets) {
        if (!dataset.enabled) continue;
        if (dataset.dataset === "home.telemetry.v1") {
          recoveryTelemetrySamples = grant.housePolicy.recoveryMode === "full"
            ? this.publishFullRecoveryTelemetry(grant, house, dataset)
            : (this.publishHistoricalTelemetry(grant, house, dataset), 0);
          continue;
        }
        if (dataset.dataset === "home.recovery.v1") {
          this.publishRecoveryArchive(grant, house, recoveryTelemetrySamples, revision);
          continue;
        }
        const projected = this.projectDataset(grant, house, dataset);
        const resourceId = `${grant.publicationId}:${dataset.dataset}`;
        if (projected) {
          this.publishDataset(grant, dataset.dataset, projected, resourceId, revision);
          continue;
        }
        this.distribute(this.createEvent({
          stugubyId: grant.stugubyId,
          eventKind: "dataset.published",
          streamId: `dataset:${grant.id}:${dataset.dataset}`,
          schema: dataset.dataset,
          resourceId,
          operation: "tombstone",
          revision: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, revision)),
          grantId: grant.id,
          grantEpoch: grant.epoch,
          payload: null,
        }), grant);
      }
    },
  projectDataset(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): JsonValue | null {
      const local = dataset.includeLocalIds;
      const publicationId = grant.publicationId;
      switch (dataset.dataset) {
        case "home.directory.v1": {
          const payload: StugubyHomeDirectoryPayload = {
            publicationId,
            name: house.name,
            timezone: house.timezone,
            ...(local ? { localHouseId: house.id } : {}),
          };
          return payload;
        }
        case "home.location.v1": {
          if (!house.location) return null;
          const payload: StugubyHomeLocationPayload = {
            publicationId,
            latitude: house.location.latitude,
            longitude: house.location.longitude,
            ...(house.location.label ? { label: house.location.label } : {}),
            ...(house.location.countryCode ? { countryCode: house.location.countryCode } : {}),
            ...(house.mapPlacement ? { mapPlacement: {
              latitude: house.mapPlacement.latitude,
              longitude: house.mapPlacement.longitude,
              metersPerPlanUnit: house.mapPlacement.metersPerPlanUnit,
              ...(house.mapPlacement.footprintFloorId ? {
                footprintFloorPublicationId: this.store.publicationId(grant.stugubyId, "floor", house.mapPlacement.footprintFloorId),
              } : {}),
            } } : {}),
            ...(house.orientationDegrees !== undefined ? { orientationDegrees: house.orientationDegrees } : {}),
          };
          return payload;
        }
        case "home.structure.v1":
          return this.projectStructure(grant, house, local);
        case "home.floorplan.v1":
          return this.projectFloorPlans(grant, house);
        case "home.sensor-catalog.v1":
          return this.projectSensors(grant, house, local);
        case "home.notes.v1": {
          const notes = this.database.listPropertyNotes({ houseId: house.id, limit: 10_000 }).map((note) => ({
            notePublicationId: this.store.publicationId(grant.stugubyId, "note", note.id),
            ...(local ? { localNoteId: note.id } : {}),
            kind: note.kind,
            text: note.text,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
          }));
          return { publicationId, notes } satisfies StugubyHomeNotesPayload;
        }
        case "home.observations.v1": {
          const observations = this.database.listObservations(house.id).map((observation) => ({
            observationPublicationId: this.store.publicationId(grant.stugubyId, "observation", observation.id),
            ...(local ? { localObservationId: observation.id } : {}),
            floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", observation.floorId),
            ...(observation.sensorId ? { sensorPublicationId: this.store.publicationId(grant.stugubyId, "sensor", observation.sensorId) } : {}),
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
          }));
          return { publicationId, observations } satisfies StugubyHomeObservationsPayload;
        }
        case "home.recovery.v1":
        case "home.telemetry.v1":
          return null;
      }
    },
  projectStructure(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House, local: boolean): StugubyHomeStructurePayload {
      const floors = house.floors.map((floor) => {
        const walls = floor.walls.map((wall) => ({
          wallPublicationId: this.store.publicationId(grant.stugubyId, "wall", wall.id),
          ...(local ? { localWallId: wall.id } : {}),
          from: { x: wall.from.x, y: wall.from.y },
          to: { x: wall.to.x, y: wall.to.y },
        }));
        const rooms = floor.rooms.map((room) => ({
          roomPublicationId: this.store.publicationId(grant.stugubyId, "room", room.id),
          ...(local ? { localRoomId: room.id } : {}),
          name: room.name,
          points: room.points.map((point) => ({ x: point.x, y: point.y })),
          ...(room.kind ? { kind: room.kind } : {}),
        }));
        const planElements = (floor.planElements ?? []).map((element) => {
          const projected: Record<string, JsonValue> = {
            planElementPublicationId: this.store.publicationId(grant.stugubyId, "plan-element", element.id),
            ...(local ? { localPlanElementId: element.id } : {}),
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
            projected.wallPublicationId = this.store.publicationId(grant.stugubyId, "wall", element.wallId);
          }
          return projected;
        });
        const result: Record<string, JsonValue> = {
          floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", floor.id),
          ...(local ? { localFloorId: floor.id } : {}),
          name: floor.name,
          width: floor.width,
          height: floor.height,
          elevation: floor.elevation,
          walls: asJson(walls),
          rooms: asJson(rooms),
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
      });
      const payload = { publicationId: grant.publicationId, floors } as unknown as StugubyHomeStructurePayload;
      assertSafeFederationPayload(payload);
      return payload;
    },
  projectFloorPlans(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House): StugubyHomeFloorPlanPayload {
      const assets = house.floors.flatMap((floor) => {
        if (!floor.backgroundImage) return [];
        const image = this.storeDataUrl(floor.backgroundImage);
        this.store.registerBlobReference(grant.stugubyId, image.digest, grant.id, grant.epoch, "local");
        return [{ floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", floor.id), image }];
      });
      return { publicationId: grant.publicationId, assets };
    },
  projectSensors(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House, local: boolean): StugubySensorCatalogPayload {
      const sensors = this.database.listSensors(house.id).map((sensor) => ({
        sensorPublicationId: this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
        ...(local ? { localSensorId: sensor.id } : {}),
        floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", sensor.floorId),
        ...(sensor.roomId ? { roomPublicationId: this.store.publicationId(grant.stugubyId, "room", sensor.roomId) } : {}),
        name: sensor.name,
        model: sensor.model,
        tags: sensor.tags.filter((tag) => tag !== "stuguby-shared"),
        enabled: sensor.enabled,
        x: sensor.x,
        y: sensor.y,
        z: sensor.z,
        metricIds: this.sensorMetrics(sensor.id),
      }));
      return { publicationId: grant.publicationId, sensors };
    },
  sensorMetrics(this: StugubyServiceInternals, sensorId: string): string[] {
      return (this.database.db.prepare("SELECT DISTINCT metric FROM measurement_samples WHERE sensor_id=? ORDER BY metric")
        .all(sensorId) as Array<{ metric: string }>).map((row) => row.metric);
    },
  publishHistoricalTelemetry(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): void {
      const policy = dataset.telemetry;
      if (!policy) return;
      if (!policy.historyFrom) {
        const boundary = new Date().toISOString();
        const completionId = sha256(`${grant.id}\n${grant.epoch}\nhistory-complete\nlive-only`);
        this.publishDataset(grant, "home.telemetry.v1", {
          publicationId: grant.publicationId,
          chunkId: completionId,
          from: boundary,
          to: boundary,
          complete: true,
          samples: [],
        } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:${completionId}`, 1);
        return;
      }
      const from = parseIso(policy.historyFrom, "Telemetry history start");
      const now = Date.now();
      // When live publication is enabled, the current UTC hour belongs solely
      // to the durable live bucket. This prevents the initial history snapshot
      // and live stream from each consuming a full allowance for that hour.
      const to = new Date(policy.live ? Math.floor(now / 3_600_000) * 3_600_000 - 1 : now).toISOString();
      const hasHistoricalRange = Date.parse(from) <= Date.parse(to);
      if (hasHistoricalRange && !this.localTelemetryHistoryComplete(from)) {
        throw new StugubyError(
          409,
          "ARCHIVED_TELEMETRY_EXPORT_UNAVAILABLE",
          "Stuguby cannot synchronously page a complete history snapshot from the bounded SQLite cache; archive-backed federation export is unavailable",
        );
      }
      const sensors = this.selectedSensors(grant, house, policy.sensorPublicationIds);
      const sensorIds = sensors.map((sensor) => sensor.id);
      const sensorPlaceholders = sensorIds.map(() => "?").join(",");
      const metricPlaceholders = policy.metricIds.map(() => "?").join(",");
      const metricClause = metricPlaceholders ? `AND metric IN (${metricPlaceholders})` : "";
      const publications = new Map(sensors.map((sensor) => [
        sensor.id,
        this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
      ]));
      const chunkSize = 2_000;
      if (hasHistoricalRange && sensorIds.length > 0) {
        const listHours = this.database.db.prepare(`SELECT
            strftime('%Y-%m-%dT%H:00:00.000Z', timestamp) AS hour_start
          FROM measurement_samples
          WHERE timestamp>=? AND timestamp<=? AND sensor_id IN (${sensorPlaceholders}) ${metricClause}
            AND strftime('%Y-%m-%dT%H', timestamp) IS NOT NULL
          GROUP BY hour_start ORDER BY hour_start LIMIT ?`);
        const selectHour = this.database.db.prepare(`WITH candidates AS (
            SELECT id,sensor_id,metric,timestamp,value,quality
            FROM measurement_samples
            WHERE timestamp>=? AND timestamp<=? AND sensor_id IN (${sensorPlaceholders}) ${metricClause}
          ), bucketed AS (
            SELECT *,ntile(?) OVER (
              ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id
            ) AS sample_bucket
            FROM candidates
          ), sampled AS (
            SELECT *,row_number() OVER (
              PARTITION BY sample_bucket ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id
            ) AS selected_rank
            FROM bucketed
          )
          SELECT sensor_id,metric,timestamp,value,quality
          FROM sampled WHERE selected_rank=1
          ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id`);
        let hourCursor = from;
        while (Date.parse(hourCursor) <= Date.parse(to)) {
          const hours = listHours.all(
            hourCursor,
            to,
            ...sensorIds,
            ...policy.metricIds,
            500,
          ) as Array<{ hour_start: string }>;
          if (hours.length === 0) break;
          for (const { hour_start: hourStart } of hours) {
            const hourEnd = new Date(Date.parse(hourStart) + 3_600_000 - 1).toISOString();
            const rows = selectHour.all(
              hourStart < from ? from : hourStart,
              hourEnd > to ? to : hourEnd,
              ...sensorIds,
              ...policy.metricIds,
              policy.maxSamplesPerHour,
            ) as Array<{
              sensor_id: string;
              metric: string;
              timestamp: string;
              value: number;
              quality: "good" | "estimated" | "stale";
            }>;
            const hourlySamples: StugubyTelemetryPayload["samples"] = rows.map((sample) => ({
              sensorPublicationId: publications.get(sample.sensor_id)!,
              metricId: sample.metric,
              timestamp: sample.timestamp,
              value: sample.value,
              quality: sample.quality,
            }));
            for (let offset = 0; offset < hourlySamples.length; offset += chunkSize) {
              const selected = hourlySamples.slice(offset, offset + chunkSize);
              const chunkIndex = Math.floor(offset / chunkSize);
              const chunkId = sha256(`${grant.id}\n${grant.epoch}\n${hourStart}\n${chunkIndex}`);
              this.publishDataset(grant, "home.telemetry.v1", {
                publicationId: grant.publicationId,
                chunkId,
                from: selected[0]!.timestamp,
                to: selected.at(-1)!.timestamp,
                complete: false,
                samples: selected,
              } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:${chunkId}`, 1);
            }
          }
          hourCursor = new Date(Date.parse(hours.at(-1)!.hour_start) + 3_600_000).toISOString();
        }
      }
      const completionTo = hasHistoricalRange ? to : from;
      const completionId = sha256(`${grant.id}\n${grant.epoch}\nhistory-complete\n${from}\n${completionTo}`);
      this.publishDataset(grant, "home.telemetry.v1", {
        publicationId: grant.publicationId,
        chunkId: completionId,
        from,
        to: completionTo,
        complete: true,
        samples: [],
      } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:${completionId}`, 1);
    },
});
