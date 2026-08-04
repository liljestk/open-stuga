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
import { SensorRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError, SensorUpdate } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { sensorFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  listSensors(houseId?: string): Sensor[] {
      const rows = (houseId
        ? this.db.prepare(`SELECT sensor.* FROM sensors AS sensor
            JOIN houses AS house ON house.id = sensor.house_id
            WHERE sensor.house_id = ? AND house.deleted_at IS NULL ORDER BY sensor.name`).all(houseId)
        : this.db.prepare(`SELECT sensor.* FROM sensors AS sensor
            JOIN houses AS house ON house.id = sensor.house_id
            WHERE house.deleted_at IS NULL ORDER BY sensor.name`).all()) as unknown as SensorRow[];
      return rows.map((row) => this.sensorWithMeasurementBindings(row));
    },
  /** Detaches direct bindings owned by one deleted logical connection. */
  detachTpLinkConnection(connectionId: string, unscopedHouseId?: string): string[] {
      return this.immediateTransaction(() => {
        const rows = (unscopedHouseId
          ? this.db.prepare(`SELECT id FROM sensors
              WHERE tp_link_connection_id = ?
                OR (house_id = ? AND tp_link_connection_id IS NULL AND tp_link_device_id IS NOT NULL)
              ORDER BY id`).all(connectionId, unscopedHouseId)
          : this.db.prepare("SELECT id FROM sensors WHERE tp_link_connection_id = ? ORDER BY id").all(connectionId)) as unknown as Array<{ id: string }>;
        if (rows.length > 0) {
          if (unscopedHouseId) {
            this.db.prepare(`UPDATE sensors
              SET tp_link_device_id = NULL, tp_link_connection_id = NULL
              WHERE tp_link_connection_id = ?
                OR (house_id = ? AND tp_link_connection_id IS NULL AND tp_link_device_id IS NOT NULL)`)
              .run(connectionId, unscopedHouseId);
          } else {
            this.db.prepare(`UPDATE sensors
              SET tp_link_device_id = NULL, tp_link_connection_id = NULL
              WHERE tp_link_connection_id = ?`).run(connectionId);
          }
        }
        return rows.map((row) => row.id);
      });
    },
  /**
     * Atomically moves existing direct-device bindings between logical TP-Link
     * connections. The expected owner makes setup migrations fail closed if a
     * concurrent request changed any sensor after it was inspected.
     */
  reassignTpLinkSensors(
      houseId: string,
      assignments: Array<{ sensorId: string; fromConnectionId: string | null; toConnectionId: string | null }>,
    ): Sensor[] {
      if (!this.getHouse(houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", "House not found");
      }
      if (assignments.length < 1 || assignments.length > 2_048) {
        throw new ClimateDataValidationError(400, "INVALID_TP_LINK_ASSIGNMENTS", "TP-Link assignment migration requires 1–2,048 sensors");
      }
      return this.immediateTransaction(() => {
        const sensorIds = new Set<string>();
        const prepared = assignments.map((assignment) => {
          const sensor = this.getSensor(assignment.sensorId);
          if (!sensor || sensor.houseId !== houseId || !sensor.tpLinkDeviceId || sensorIds.has(sensor.id)) {
            throw new ClimateDataValidationError(
              409,
              "TP_LINK_BINDING_CHANGED",
              "Every TP-Link assignment must reference one unique bound sensor in the selected house",
            );
          }
          sensorIds.add(sensor.id);
          if ((sensor.tpLinkConnectionId ?? null) !== assignment.fromConnectionId) {
            throw new ClimateDataValidationError(
              409,
              "TP_LINK_BINDING_CHANGED",
              `TP-Link binding ownership changed for sensor ${sensor.id}`,
            );
          }
          if (assignment.toConnectionId !== null
            && (!assignment.toConnectionId.trim() || assignment.toConnectionId !== assignment.toConnectionId.trim())) {
            throw new ClimateDataValidationError(400, "INVALID_TP_LINK_CONNECTION_ID", "TP-Link connection id is invalid");
          }
          return { sensor, toConnectionId: assignment.toConnectionId };
        });
        return prepared.map(({ sensor, toConnectionId }) => this.updateSensor(sensor.id, {
          tpLinkConnectionId: toConnectionId,
        })!);
      });
    },
  getSensor(id: string): Sensor | null {
      const row = this.db.prepare(`SELECT sensor.* FROM sensors AS sensor
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE sensor.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as SensorRow | undefined;
      return row ? this.sensorWithMeasurementBindings(row) : null;
    },
  sensorWithMeasurementBindings(row: SensorRow): Sensor {
      const sensor = sensorFromRow(row);
      const bindings = this.db.prepare("SELECT metric, entity_id FROM sensor_measurement_bindings WHERE sensor_id = ? ORDER BY metric")
        .all(sensor.id) as unknown as Array<{ metric: string; entity_id: string }>;
      const recorded = sensor.enabled ? [] : this.db.prepare(
        "SELECT metric FROM sensor_recorded_measurements WHERE sensor_id = ? ORDER BY metric",
      ).all(sensor.id) as unknown as Array<{ metric: string }>;
      return {
        ...sensor,
        ...(bindings.length > 0
          ? { measurementEntityIds: Object.fromEntries(bindings.map((binding) => [binding.metric, binding.entity_id])) }
          : {}),
        ...(recorded.length > 0 ? { recordedMeasurementIds: recorded.map((item) => item.metric) } : {}),
      };
    },
  createSensor(input: Omit<Sensor, "id"> & { id?: string }): Sensor {
      let sensor: Sensor = {
        ...input,
        id: input.id ?? randomUUID(),
        energyMeterRole: input.energyMeterRole ?? "standalone",
      };
      return this.immediateTransaction(() => {
        this.assertTelemetryResourceIdAvailable("sensor", sensor.id);
        this.validateSensorPlacement(sensor);
        sensor = this.normalizeSensorRoom(sensor, {
          roomIdProvided: Object.hasOwn(input, "roomId"),
          roomProvided: true,
          resolveLegacyLabel: !Object.hasOwn(input, "roomId"),
        });
        this.validateTpLinkDeviceBinding(sensor);
        this.writeSensor(sensor, true);
        this.db.prepare("DELETE FROM analytics_daily_findings WHERE house_id = ?").run(sensor.houseId);
        return sensor;
      });
    },
  updateSensor(id: string, patch: SensorUpdate): Sensor | null {
      return this.immediateTransaction(() => {
        const current = this.getSensor(id);
        if (!current) return null;
        const { tpLinkDeviceId, tpLinkConnectionId, ...fields } = patch;
        const sensor: Sensor = { ...current, ...fields, id };
        if (tpLinkDeviceId === null) delete sensor.tpLinkDeviceId;
        else if (tpLinkDeviceId !== undefined) sensor.tpLinkDeviceId = tpLinkDeviceId;
        if (tpLinkConnectionId === null) delete sensor.tpLinkConnectionId;
        else if (tpLinkConnectionId !== undefined) sensor.tpLinkConnectionId = tpLinkConnectionId;
        if (!sensor.tpLinkDeviceId) delete sensor.tpLinkConnectionId;
        this.validateSensorPlacement(sensor);
        if (sensor.houseId !== current.houseId) this.requireImmutableTelemetryLineage("sensor", id);
        const normalizedSensor = this.normalizeSensorRoom(sensor, {
          roomIdProvided: Object.hasOwn(patch, "roomId"),
          roomProvided: Object.hasOwn(patch, "room"),
          resolveLegacyLabel: !Object.hasOwn(patch, "roomId")
            && ["houseId", "floorId", "room"].some((field) => Object.hasOwn(patch, field)),
        });
        this.validateTpLinkDeviceBinding(normalizedSensor);
        this.writeSensor(normalizedSensor, false);
        this.db.prepare("DELETE FROM analytics_daily_findings WHERE house_id IN (?, ?)")
          .run(current.houseId, normalizedSensor.houseId);
        if (normalizedSensor.enabled && normalizedSensor.tpLinkDeviceId
          && (!current.enabled || !current.tpLinkDeviceId
            || current.tpLinkDeviceId !== normalizedSensor.tpLinkDeviceId)) {
          this.rearmEligibleNotSupportedTapoGaps(normalizedSensor.id, null);
        }
        return normalizedSensor;
      });
    },
  bulkUpdateSensorBindings(
      houseId: string,
      mappings: Array<{ sensorId: string; measurementEntityIds: Record<string, string> }>,
    ): Sensor[] {
      if (!this.getHouse(houseId)) throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", "House not found");
      if (mappings.length < 1 || mappings.length > 100) {
        throw new ClimateDataValidationError(400, "INVALID_BULK_MAPPING", "Bulk mapping requires 1–100 sensors");
      }
      return this.immediateTransaction(() => {
        const sensorIds = new Set<string>();
        const claims = new Set<string>();
        const prepared = mappings.map((mapping) => {
          const sensor = this.getSensor(mapping.sensorId);
          if (!sensor || sensor.houseId !== houseId || sensorIds.has(sensor.id)) {
            throw new ClimateDataValidationError(409, "INVALID_BULK_MAPPING", "Every mapping must reference one unique sensor in the selected house");
          }
          sensorIds.add(sensor.id);
          const normalized: Record<string, string> = {};
          for (const [metric, entityId] of Object.entries(mapping.measurementEntityIds)) {
            if (!this.getMeasurementDefinition(metric) || typeof entityId !== "string" || !entityId.trim() || entityId.length > 500) {
              throw new ClimateDataValidationError(400, "INVALID_BULK_MAPPING", "Every mapping requires a known metric and non-empty entity id");
            }
            const claim = `${metric}\u0000${entityId.trim()}`;
            if (claims.has(claim)) {
              throw new ClimateDataValidationError(409, "DUPLICATE_ENTITY_CLAIM", "One entity cannot be claimed by two sensors for the same metric");
            }
            claims.add(claim);
            normalized[metric] = entityId.trim();
          }
          if (Object.keys(normalized).length === 0) {
            throw new ClimateDataValidationError(400, "INVALID_BULK_MAPPING", "Each sensor requires at least one entity mapping");
          }
          return { sensor, normalized };
        });
        return prepared.map(({ sensor, normalized }) => this.updateSensor(sensor.id, { measurementEntityIds: normalized })!);
      });
    },
});
