import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { MeasurementDefinitionRow, MeasurementSampleRow, SensorDataGapSource } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { measurementDefinitionFromRow, measurementSampleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  validateHouseLayoutForObservations(houseId: string, floors: Floor[]): void {
      const floorsById = new Map(floors.map((floor) => [floor.id, floor]));
      const rows = this.db.prepare(`SELECT id, floor_id, x, y FROM observations
        WHERE house_id = ? ORDER BY id`).all(houseId) as unknown as Array<{
        id: string;
        floor_id: string;
        x: number | null;
        y: number | null;
      }>;
      for (const observation of rows) {
        const floor = floorsById.get(observation.floor_id);
        if (!floor) {
          throw new ClimateDataValidationError(
            409,
            "LAYOUT_ORPHANS_OBSERVATION",
            `Floor ${observation.floor_id} cannot be removed while observation ${observation.id} uses it`,
          );
        }
        if (observation.x !== null && observation.y !== null
          && (observation.x < 0 || observation.x > floor.width
            || observation.y < 0 || observation.y > floor.height)) {
          throw new ClimateDataValidationError(
            409,
            "LAYOUT_EXCLUDES_OBSERVATION",
            `Floor ${floor.id} extent would exclude observation ${observation.id}`,
          );
        }
      }
    },
  validateSensorPlacement(sensor: Sensor): void {
      if (![sensor.x, sensor.y, sensor.z].every(Number.isFinite)) {
        throw new ClimateDataValidationError(400, "INVALID_SENSOR_COORDINATE", "Sensor x, y, and z must be finite numbers");
      }
      const house = this.getHouse(sensor.houseId);
      if (!house) {
        throw new ClimateDataValidationError(404, "SENSOR_HOUSE_NOT_FOUND", `House ${sensor.houseId} does not exist`);
      }
      const floor = house.floors.find((candidate) => candidate.id === sensor.floorId);
      if (!floor) {
        throw new ClimateDataValidationError(422, "SENSOR_FLOOR_NOT_FOUND", `Floor ${sensor.floorId} does not belong to house ${sensor.houseId}`);
      }
      if (sensor.x < 0 || sensor.x > floor.width || sensor.y < 0 || sensor.y > floor.height) {
        throw new ClimateDataValidationError(
          422,
          "SENSOR_OUT_OF_BOUNDS",
          `Sensor x/y must be within floor ${floor.id}: 0 <= x <= ${floor.width}, 0 <= y <= ${floor.height}`,
        );
      }
    },
  normalizeSensorRoom(
      sensor: Sensor,
      options: { roomIdProvided: boolean; roomProvided: boolean; resolveLegacyLabel: boolean },
    ): Sensor {
      const house = this.getHouse(sensor.houseId);
      const floor = house?.floors.find((candidate) => candidate.id === sensor.floorId);
      // Placement validation runs immediately before this method. Keep this
      // defensive guard so future callers cannot accidentally bypass ownership.
      if (!house || !floor) return { ...sensor, roomId: null };

      if (options.roomIdProvided) {
        if (sensor.roomId === null || sensor.roomId === undefined) return { ...sensor, roomId: null };
        if (typeof sensor.roomId !== "string" || !sensor.roomId.trim() || sensor.roomId !== sensor.roomId.trim()) {
          throw new ClimateDataValidationError(400, "INVALID_SENSOR_ROOM_ID", "roomId must be null or a non-empty trimmed string");
        }
        const linkedRoom = floor.rooms.find((candidate) => candidate.id === sensor.roomId);
        if (!linkedRoom) {
          throw new ClimateDataValidationError(
            422,
            "SENSOR_ROOM_NOT_FOUND",
            `Room ${sensor.roomId} does not belong to floor ${sensor.floorId} in house ${sensor.houseId}`,
          );
        }
        if (options.roomProvided && sensor.room !== linkedRoom.name) {
          throw new ClimateDataValidationError(
            422,
            "SENSOR_ROOM_LABEL_MISMATCH",
            `room must match the linked room name ${linkedRoom.name}`,
          );
        }
        return { ...sensor, roomId: linkedRoom.id, room: linkedRoom.name };
      }

      if (options.resolveLegacyLabel) {
        const matches = floor.rooms.filter((candidate) => candidate.name === sensor.room);
        return { ...sensor, roomId: matches.length === 1 ? matches[0]!.id : null };
      }

      if (sensor.roomId === null || sensor.roomId === undefined) return { ...sensor, roomId: null };
      const linkedRoom = floor.rooms.find((candidate) => candidate.id === sensor.roomId);
      if (!linkedRoom) {
        throw new ClimateDataValidationError(
          422,
          "SENSOR_ROOM_NOT_FOUND",
          `Room ${sensor.roomId} does not belong to floor ${sensor.floorId} in house ${sensor.houseId}`,
        );
      }
      return { ...sensor, roomId: linkedRoom.id, room: linkedRoom.name };
    },
  validateTpLinkDeviceBinding(sensor: Sensor): void {
      if (sensor.tpLinkDeviceId === undefined) {
        if (sensor.tpLinkConnectionId !== undefined) {
          throw new ClimateDataValidationError(400, "INVALID_TP_LINK_BINDING", "tpLinkConnectionId requires tpLinkDeviceId");
        }
        return;
      }
      if (!sensor.tpLinkDeviceId.trim() || sensor.tpLinkDeviceId !== sensor.tpLinkDeviceId.trim()) {
        throw new ClimateDataValidationError(
          400,
          "INVALID_TP_LINK_DEVICE_ID",
          "tpLinkDeviceId must be a non-empty trimmed string",
        );
      }
      if (sensor.tpLinkConnectionId !== undefined
        && (!sensor.tpLinkConnectionId.trim() || sensor.tpLinkConnectionId !== sensor.tpLinkConnectionId.trim())) {
        throw new ClimateDataValidationError(400, "INVALID_TP_LINK_CONNECTION_ID", "tpLinkConnectionId must be a non-empty trimmed string");
      }
      const existing = this.db.prepare(`SELECT id FROM sensors
        WHERE house_id = ? AND COALESCE(tp_link_connection_id, '') = COALESCE(?, '')
          AND tp_link_device_id = ? AND id <> ?`)
        .get(sensor.houseId, sensor.tpLinkConnectionId ?? null, sensor.tpLinkDeviceId, sensor.id) as unknown as { id: string } | undefined;
      if (existing) {
        throw new ClimateDataValidationError(
          409,
          "TP_LINK_DEVICE_ALREADY_MAPPED",
          `TP-Link child device ${sensor.tpLinkDeviceId} is already mapped to sensor ${existing.id}`,
        );
      }
    },
  writeSensor(sensor: Sensor, insert: boolean): void {
      const energyMeterRole = sensor.energyMeterRole ?? "standalone";
      if (!["whole_home", "submeter", "standalone"].includes(energyMeterRole)) {
        throw new ClimateDataValidationError(400, "INVALID_ENERGY_METER_ROLE", "Unsupported electricity meter role");
      }
      if (energyMeterRole === "whole_home") {
        const existingWholeHome = this.db.prepare(`SELECT id FROM sensors
          WHERE house_id = ? AND energy_meter_role = 'whole_home' AND id <> ? LIMIT 1`)
          .get(sensor.houseId, sensor.id) as { id: string } | undefined;
        if (existingWholeHome) {
          throw new ClimateDataValidationError(
            409,
            "WHOLE_HOME_METER_ALREADY_EXISTS",
            `Sensor ${existingWholeHome.id} is already the whole-Home electricity meter`,
          );
        }
      }
      const bindings: Record<string, string> = { ...(sensor.measurementEntityIds ?? {}) };
      if (sensor.temperatureEntityId) bindings.temperature ??= sensor.temperatureEntityId;
      if (sensor.humidityEntityId) bindings.humidity ??= sensor.humidityEntityId;
      for (const metric of Object.keys(bindings)) {
        if (!this.getMeasurementDefinition(metric)) {
          throw new ClimateDataValidationError(422, "UNKNOWN_METRIC", `Unknown measurement metric binding: ${metric}`);
        }
      }
      const homeAssistantBindings = { ...bindings };
      if (sensor.batteryEntityId) homeAssistantBindings.battery ??= sensor.batteryEntityId;
      const metricsByEntityId = new Map<string, string>();
      const existingBinding = this.db.prepare(`SELECT binding.sensor_id, binding.metric
        FROM sensor_measurement_bindings binding
        JOIN sensors owner ON owner.id = binding.sensor_id
        WHERE owner.house_id = ? AND TRIM(binding.entity_id) = ? AND binding.sensor_id <> ? LIMIT 1`);
      const legacyBatteryBinding = this.db.prepare(`SELECT id AS sensor_id, 'battery' AS metric FROM sensors
        WHERE house_id = ? AND id <> ? AND TRIM(battery_entity_id) = ?
          AND NOT EXISTS (
            SELECT 1 FROM sensor_measurement_bindings
            WHERE sensor_id = sensors.id AND metric = 'battery'
          )
        LIMIT 1`);
      for (const [metric, rawEntityId] of Object.entries(homeAssistantBindings)) {
        const entityId = rawEntityId.trim();
        const previousMetric = metricsByEntityId.get(entityId);
        if (previousMetric && previousMetric !== metric) {
          throw new ClimateDataValidationError(
            409,
            "HOME_ASSISTANT_ENTITY_ALREADY_MAPPED",
            `Home Assistant entity ${entityId} is mapped to both ${previousMetric} and ${metric} on sensor ${sensor.id}`,
          );
        }
        metricsByEntityId.set(entityId, metric);
        const owner = existingBinding.get(sensor.houseId, entityId, sensor.id) as { sensor_id: string; metric: string } | undefined
          ?? legacyBatteryBinding.get(sensor.houseId, sensor.id, entityId) as { sensor_id: string; metric: string } | undefined;
        if (owner) {
          throw new ClimateDataValidationError(
            409,
            "HOME_ASSISTANT_ENTITY_ALREADY_MAPPED",
            `Home Assistant entity ${entityId} is already mapped to ${owner.metric} on sensor ${owner.sensor_id}`,
          );
        }
      }
      const values = [sensor.houseId, sensor.floorId, sensor.name, sensor.roomId ?? null, sensor.room, sensor.model, sensor.x, sensor.y, sensor.z,
        sensor.temperatureEntityId ?? null, sensor.humidityEntityId ?? null, sensor.batteryEntityId ?? null,
        sensor.tpLinkDeviceId ?? null, sensor.tpLinkConnectionId ?? null,
        null,
        energyMeterRole, JSON.stringify(sensor.tags), sensor.enabled ? 1 : 0, sensor.id];
      if (insert) {
        this.db.prepare(`INSERT INTO sensors
          (house_id, floor_id, name, room_id, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tp_link_device_id, tp_link_connection_id,
           measurement_entity_ids_json, energy_meter_role, tags_json, enabled, id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(...values);
      } else {
        this.db.prepare(`UPDATE sensors SET house_id = ?, floor_id = ?, name = ?, room_id = ?, room = ?, model = ?, x = ?, y = ?, z = ?,
          temperature_entity_id = ?, humidity_entity_id = ?, battery_entity_id = ?, tp_link_device_id = ?, tp_link_connection_id = ?, measurement_entity_ids_json = ?,
          energy_meter_role = ?, tags_json = ?, enabled = ? WHERE id = ?`)
          .run(...values);
      }
      this.db.prepare("DELETE FROM sensor_measurement_bindings WHERE sensor_id = ?").run(sensor.id);
      const insertBinding = this.db.prepare("INSERT INTO sensor_measurement_bindings(sensor_id, metric, entity_id) VALUES (?, ?, ?)");
      for (const [metric, entityId] of Object.entries(bindings)) insertBinding.run(sensor.id, metric, entityId);
    },
  deleteSensor(id: string): boolean {
      return this.immediateTransaction(() => {
        const sensor = this.getSensor(id);
        if (!sensor) return false;
        const historicalAlert = this.db.prepare(`SELECT id FROM alert_events
          WHERE sensor_id = ? LIMIT 1`).get(id) as { id: string } | undefined;
        if (historicalAlert) {
          throw new ClimateDataValidationError(
            409,
            "ALERT_HISTORY_EXISTS",
            `Sensor ${id} has historical alert events; disable it instead of deleting it`,
          );
        }
        this.requireImmutableTelemetryLineage("sensor", id);
        const deleted = Number(this.db.prepare("DELETE FROM sensors WHERE id = ?").run(id).changes) > 0;
        if (!deleted) return false;
        this.db.prepare(`DELETE FROM static_parameters
          WHERE scope_type = 'sensor' AND scope_id = ?`).run(id);
        this.db.prepare("DELETE FROM analytics_daily_findings WHERE house_id = ?").run(sensor.houseId);
        return true;
      });
    },
  listMeasurementDefinitions(includeDisabled = true): MeasurementDefinition[] {
      const rows = (includeDisabled
        ? this.db.prepare("SELECT * FROM measurement_definitions ORDER BY builtin DESC, id").all()
        : this.db.prepare("SELECT * FROM measurement_definitions WHERE enabled = 1 ORDER BY builtin DESC, id").all()) as unknown as MeasurementDefinitionRow[];
      return rows.map(measurementDefinitionFromRow);
    },
  getMeasurementDefinition(id: string): MeasurementDefinition | null {
      const row = this.db.prepare("SELECT * FROM measurement_definitions WHERE id = ?").get(id) as unknown as MeasurementDefinitionRow | undefined;
      return row ? measurementDefinitionFromRow(row) : null;
    },
  createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
      this.db.prepare(`INSERT INTO measurement_definitions
        (id, labels_json, unit, dimension, allowed_units_json, kind, default_aggregation,
         generic_history_enabled, generic_stats_enabled, precision, valid_min, valid_max, display_min, display_max,
         interpolation_delta, color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(definition.id, JSON.stringify(definition.labels), definition.unit, definition.dimension ?? "finite_scalar",
          JSON.stringify(definition.allowedUnits ?? [definition.unit]), definition.kind ?? "gauge", definition.defaultAggregation ?? "mean",
          definition.genericHistoryEnabled === false ? 0 : 1, definition.genericStatsEnabled === false ? 0 : 1, definition.precision,
          definition.validMin, definition.validMax, definition.displayMin, definition.displayMax,
          definition.interpolationDelta, definition.colorScale, definition.builtin ? 1 : 0, definition.enabled ? 1 : 0,
          definition.spatialInterpolation ? 1 : 0, definition.forecastSupported ? 1 : 0);
      return this.getMeasurementDefinition(definition.id)!;
    },
  updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null {
      const current = this.getMeasurementDefinition(id);
      if (!current) return null;
      const next: MeasurementDefinition = { ...current, ...patch, id, builtin: current.builtin };
      if (next.unit !== current.unit) {
        const usage = this.db.prepare(`SELECT 1 FROM (
          SELECT metric FROM measurement_samples WHERE metric = ?
          UNION ALL SELECT metric FROM sensor_measurement_bindings WHERE metric = ?
          UNION ALL SELECT metric FROM alert_rules WHERE metric = ?
        ) LIMIT 1`).get(id, id, id);
        if (usage) {
          throw new ClimateDataValidationError(
            409,
            "UNIT_IMMUTABLE",
            "Canonical unit cannot change after samples, sensor bindings, or alert rules reference the metric",
          );
        }
      }
      this.db.prepare(`UPDATE measurement_definitions SET labels_json = ?, unit = ?, dimension = ?, allowed_units_json = ?,
        kind = ?, default_aggregation = ?, generic_history_enabled = ?, generic_stats_enabled = ?, precision = ?,
        valid_min = ?, valid_max = ?, display_min = ?, display_max = ?, interpolation_delta = ?, color_scale = ?, enabled = ?,
        spatial_interpolation = ?, forecast_supported = ? WHERE id = ?`)
        .run(JSON.stringify(next.labels), next.unit, next.dimension ?? "finite_scalar", JSON.stringify(next.allowedUnits ?? [next.unit]),
          next.kind ?? "gauge", next.defaultAggregation ?? "mean", next.genericHistoryEnabled === false ? 0 : 1,
          next.genericStatsEnabled === false ? 0 : 1, next.precision, next.validMin, next.validMax, next.displayMin,
          next.displayMax, next.interpolationDelta, next.colorScale, next.enabled ? 1 : 0,
          next.spatialInterpolation ? 1 : 0, next.forecastSupported ? 1 : 0, id);
      if (next.enabled && !current.enabled) this.rearmEligibleNotSupportedTapoGaps(null, id);
      return next;
    },
  disableMeasurementDefinition(id: string): MeasurementDefinition | null {
      const current = this.getMeasurementDefinition(id);
      if (!current) return null;
      this.db.prepare("UPDATE measurement_definitions SET enabled = 0 WHERE id = ?").run(id);
      return { ...current, enabled: false };
    },
  insertMeasurementSample(
      sample: MeasurementSample,
      deduplicateAcrossSources = false,
      enqueueAlertEvaluation = false,
    ): boolean {
      if (!this.getSensor(sample.sensorId)) return false;
      if (deduplicateAcrossSources && this.db.prepare(`SELECT 1 FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND timestamp = ? LIMIT 1`)
        .get(sample.sensorId, sample.metric, sample.timestamp)) return false;
      const result = this.db.prepare(`INSERT OR IGNORE INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sample.sensorId, sample.metric, sample.value, sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);
      if (Number(result.changes) === 0) return false;
      if (enqueueAlertEvaluation) {
        this.db.prepare("INSERT INTO alert_evaluation_queue(measurement_sample_id) VALUES (?)")
          .run(result.lastInsertRowid);
      }
      return true;
    },
  insertMeasurementSamples(
      samples: MeasurementSample[],
      options: { deduplicateAcrossSources?: boolean; enqueueAlertEvaluation?: boolean } = {},
    ): MeasurementSample[] {
      return this.immediateTransaction(() => {
        this.prepareTelemetrySources(samples.map((sample) => sample.source));
        const inserted: MeasurementSample[] = [];
        for (const sample of samples) {
          if (this.insertMeasurementSample(
            sample,
            options.deduplicateAcrossSources,
            options.enqueueAlertEvaluation,
          )) inserted.push(sample);
        }
        return inserted;
      });
    },
  latestMeasurementSamples(houseId?: string): MeasurementSample[] {
      const where = houseId ? "WHERE s.house_id = ? AND house.deleted_at IS NULL" : "WHERE house.deleted_at IS NULL";
      const rows = this.db.prepare(`SELECT ms.sensor_id, ms.metric, ms.value, ms.canonical_unit,
          ms.timestamp, ms.source, ms.quality
        FROM sensors s JOIN houses AS house ON house.id = s.house_id
        CROSS JOIN measurement_definitions definition
        JOIN measurement_samples ms ON ms.id = (
          SELECT latest.id FROM measurement_samples latest
          WHERE latest.sensor_id = s.id AND latest.metric = definition.id
          ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
        )
        ${where}
        ORDER BY ms.sensor_id, ms.metric`)
        .all(...(houseId ? [houseId] : [])) as unknown as MeasurementSampleRow[];
      return rows.map(measurementSampleFromRow);
    },
  getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? AND metric = ? ORDER BY timestamp DESC, id DESC LIMIT 1`)
        .get(sensorId, metric) as unknown as MeasurementSampleRow | undefined;
      return row ? measurementSampleFromRow(row) : null;
    },
  measurementSampleAtOrBefore(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      timestamp: string,
    ): MeasurementSample | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND source = ? AND timestamp <= ?
        ORDER BY timestamp DESC, id DESC LIMIT 1`)
        .get(sensorId, metric, source, timestamp) as unknown as MeasurementSampleRow | undefined;
      return row ? measurementSampleFromRow(row) : null;
    },
  measurementHistory(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    limit = 20_000,
    before?: { timestamp: string; source: string },
  ): MeasurementSample[] {
      if (!this.getSensor(sensorId)) return [];
      const cursor = before
        ? "AND (timestamp < ? OR (timestamp = ? AND source < ?))"
        : "";
      const parameters: Array<string | number> = [sensorId, metric, from, to];
      if (before) parameters.push(before.timestamp, before.timestamp, before.source);
      parameters.push(limit);
      const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
        SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
        FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
          ${cursor}
        ORDER BY timestamp DESC, source DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, source ASC, id ASC`).all(...parameters) as unknown as MeasurementSampleRow[];
      return rows.map(measurementSampleFromRow);
    },
});
