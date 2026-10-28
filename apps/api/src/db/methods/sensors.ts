import { randomUUID } from "node:crypto";
import type { Sensor } from "@climate-twin/contracts";
import { SensorRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { SensorUpdate } from "../support/record-types.js";
import { sensorFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listSensors(houseId?: string): Sensor[];
    detachTpLinkConnection(connectionId: string, unscopedHouseId?: string): string[];
    reassignTpLinkSensors(houseId: string, assignments: Array<{
            sensorId: string;
            fromConnectionId: string | null;
            toConnectionId: string | null;
        }>): Sensor[];
    getSensor(id: string): Sensor | null;
    sensorWithMeasurementBindings(row: SensorRow): Sensor;
    createSensor(input: Omit<Sensor, "id"> & {
            id?: string;
        }): Sensor;
    updateSensor(id: string, patch: SensorUpdate): Sensor | null;
    bulkUpdateSensorBindings(houseId: string, mappings: Array<{
            sensorId: string;
            measurementEntityIds: Record<string, string>;
        }>): Sensor[];
    validateSensorPlacement(sensor: Sensor): void;
    normalizeSensorRoom(
        sensor: Sensor,
        options: { roomIdProvided: boolean; roomProvided: boolean; resolveLegacyLabel: boolean },
      ): Sensor;
    validateTpLinkDeviceBinding(sensor: Sensor): void;
    writeSensor(sensor: Sensor, insert: boolean): void;
    deleteSensor(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    listSensors(houseId?: string): Sensor[];
    detachTpLinkConnection(connectionId: string, unscopedHouseId?: string): string[];
    reassignTpLinkSensors(houseId: string, assignments: Array<{
            sensorId: string;
            fromConnectionId: string | null;
            toConnectionId: string | null;
        }>): Sensor[];
    getSensor(id: string): Sensor | null;
    createSensor(input: Omit<Sensor, "id"> & {
            id?: string;
        }): Sensor;
    updateSensor(id: string, patch: SensorUpdate): Sensor | null;
    bulkUpdateSensorBindings(houseId: string, mappings: Array<{
            sensorId: string;
            measurementEntityIds: Record<string, string>;
        }>): Sensor[];
    deleteSensor(id: string): boolean;
  }
}

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
});
