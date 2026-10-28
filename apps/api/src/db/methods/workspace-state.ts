import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MeasurementSample, Reading, SecurityAuditEvent, Floor, Sensor } from "@climate-twin/contracts";
import { DEMO_TELEMETRY_SOURCES, boundedCollectionLimit, boundedCollectionOffset, DEFAULT_PROPERTY_ID } from "../support/domain-limits.js";
import { DemoTelemetryPurgeResult, IntegrationMappingKind, IntegrationMappingSet, SecurityAuditEventInput } from "../support/record-types.js";
import { IntegrationMappingSetRow, SecurityAuditEventRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { parseJson } from "../support/json-values.js";
import { securityAuditEventFromRow } from "../support/row-mappers.js";
import { canonicalIntegrationMappingsJson } from "../support/json-values.js";
import { registerDatabaseMethods } from "../core.js";

function ensureDemoTelemetryPurgeIndexes(database: DatabaseSync): void {
  // Real installations normally contain no synthetic rows. Partial indexes
  // keep that safety check proportional to synthetic data instead of scanning
  // the complete local telemetry buffer during every process start.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_measurement_samples_demo_source
      ON measurement_samples(source, sensor_id, metric)
      WHERE source IN ('mock', 'replay');
    CREATE INDEX IF NOT EXISTS idx_readings_demo_source
      ON readings(source)
      WHERE source IN ('mock', 'replay');
    CREATE INDEX IF NOT EXISTS idx_outdoor_temperature_demo_source
      ON outdoor_temperature_samples(source)
      WHERE source = 'mock';
  `);
}

declare module "../core.js" {
  interface DatabaseInternals {
    isRealDataMode(): boolean;
    realDataModeActivatedAt(): string | null;
    mockScenarioId(): string | null;
    recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent;
    listSecurityAuditEvents(limit?: number, offset?: number): SecurityAuditEvent[];
    setMockScenarioId(scenario: string): void;
    getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null;
    saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T>;
    activateRealDataMode(): DemoTelemetryPurgeResult;
    purgeSourceLabelledDemoTelemetry(): void;
    purgeSharedHomeLocalState(houseId?: string): void;
    prepareTelemetrySources(sources: Array<MeasurementSample["source"] | Reading["source"]>): void;
    seed(): void;
    close(): void;
  }

  interface ClimateDatabaseCore {
    isRealDataMode(): boolean;
    realDataModeActivatedAt(): string | null;
    mockScenarioId(): string | null;
    recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent;
    listSecurityAuditEvents(limit?: number, offset?: number): SecurityAuditEvent[];
    setMockScenarioId(scenario: string): void;
    getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null;
    saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T>;
    activateRealDataMode(): DemoTelemetryPurgeResult;
    purgeSharedHomeLocalState(houseId?: string): void;
    seed(): void;
    close(): void;
  }
}

registerDatabaseMethods({
  isRealDataMode(): boolean {
      return (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value === "real";
    },
  realDataModeActivatedAt(): string | null {
      if (!this.isRealDataMode()) return null;
      return (this.db.prepare("SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'").get() as { value: string } | undefined)?.value ?? null;
    },
  mockScenarioId(): string | null {
      return (this.db.prepare("SELECT value FROM metadata WHERE key = 'mock_scenario_id'").get() as { value: string } | undefined)?.value ?? null;
    },
  recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent {
      const subjectId = input.subjectId.trim();
      if (!subjectId || subjectId.length > 512) throw new Error("Security audit subject id must contain 1 to 512 characters");
      if (input.actorUserId !== null && (!input.actorUserId.trim() || input.actorUserId.length > 200)) {
        throw new Error("Security audit actor id must contain 1 to 200 characters when present");
      }
      const details = input.details ?? {};
      const entries = Object.entries(details);
      if (entries.length > 32 || entries.some(([key, value]) => (
        !key || key.length > 80
        || (typeof value === "string" && value.length > 512)
        || (value !== null && !["string", "number", "boolean"].includes(typeof value))
        || (typeof value === "number" && !Number.isFinite(value))
      ))) {
        throw new Error("Security audit details must contain at most 32 bounded scalar fields");
      }
      const detailsJson = JSON.stringify(details);
      if (Buffer.byteLength(detailsJson, "utf8") > 8_192) throw new Error("Security audit details exceed 8 KiB");
      const event: SecurityAuditEvent = {
        id: randomUUID(),
        eventType: input.eventType,
        outcome: input.outcome ?? "succeeded",
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        subjectType: input.subjectType,
        subjectId,
        details,
        createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
      };
      this.db.prepare(`INSERT INTO security_audit_events
        (id, event_type, outcome, actor_user_id, actor_role, subject_type, subject_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.id, event.eventType, event.outcome, event.actorUserId, event.actorRole, event.subjectType,
          event.subjectId, detailsJson, event.createdAt);
      return event;
    },
  listSecurityAuditEvents(limit = 100, offset = 0): SecurityAuditEvent[] {
      const rows = this.db.prepare(`SELECT id, event_type, outcome, actor_user_id, actor_role,
          subject_type, subject_id, details_json, created_at
        FROM security_audit_events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset)) as unknown as SecurityAuditEventRow[];
      return rows.map(securityAuditEventFromRow);
    },
  setMockScenarioId(scenario: string): void {
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('mock_scenario_id', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(scenario);
    },
  getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null {
      const row = this.db.prepare("SELECT * FROM integration_mapping_sets WHERE kind = ?")
        .get(kind) as unknown as IntegrationMappingSetRow | undefined;
      if (!row) return null;
      let mappings: unknown;
      try {
        mappings = parseJson<unknown>(row.mappings_json);
      } catch {
        throw new Error(`Stored ${kind} integration mappings contain invalid JSON`);
      }
      if (!Array.isArray(mappings)) throw new Error(`Stored ${kind} integration mappings are not an array`);
      const canonicalJson = canonicalIntegrationMappingsJson(mappings);
      if (canonicalJson !== row.mappings_json) throw new Error(`Stored ${kind} integration mappings are not canonical`);
      const actualHash = createHash("sha256").update(row.mappings_json).digest("hex");
      if (actualHash !== row.content_hash) throw new Error(`Stored ${kind} integration mapping hash does not match its content`);
      return {
        kind: row.kind,
        contentHash: row.content_hash,
        revision: row.revision,
        mappings: mappings as T[],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
  /** Atomically imports a complete validated mapping set; identical content is a no-op. */
  saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T> {
      if (kind !== "home-assistant" && kind !== "tp-link") throw new Error("Unsupported integration mapping kind");
      if (!Array.isArray(mappings)) throw new Error("Integration mappings must be an array");
      const mappingsJson = canonicalIntegrationMappingsJson(mappings);
      const contentHash = createHash("sha256").update(mappingsJson).digest("hex");
      return this.immediateTransaction(() => {
        // Read the raw row here instead of the strict getter so a valid source
        // file can repair malformed JSON, a mismatched hash, or old ordering.
        const current = this.db.prepare("SELECT * FROM integration_mapping_sets WHERE kind = ?")
          .get(kind) as unknown as IntegrationMappingSetRow | undefined;
        if (current?.content_hash === contentHash && current.mappings_json === mappingsJson) {
          return this.getIntegrationMappingSet<T>(kind)!;
        }
        const timestamp = new Date().toISOString();
        this.db.prepare(`INSERT INTO integration_mapping_sets
          (kind, content_hash, revision, mappings_json, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?)
          ON CONFLICT(kind) DO UPDATE SET
            content_hash = excluded.content_hash,
            revision = CASE WHEN integration_mapping_sets.revision >= 1
              THEN integration_mapping_sets.revision + 1 ELSE 1 END,
            mappings_json = excluded.mappings_json,
            updated_at = excluded.updated_at`)
          .run(kind, contentHash, mappingsJson, timestamp, timestamp);
        return this.getIntegrationMappingSet<T>(kind)!;
      });
    },
  /**
     * Permanently latches this database into real-data mode and removes every
     * persisted value that could have been produced by the demo runtime.
     */
  activateRealDataMode(): DemoTelemetryPurgeResult {
      return this.immediateTransaction(() => {
        const currentMode = (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value;
        const existingActivatedAt = (this.db.prepare(
          "SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'",
        ).get() as { value: string } | undefined)?.value;
        if (currentMode === "real") {
          const activatedAt = existingActivatedAt ?? new Date().toISOString();
          if (!existingActivatedAt) {
            this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
          }
          return {
            activated: false,
            activatedAt,
            readings: 0,
            measurementSamples: 0,
            outdoorTemperatureSamples: 0,
            alertEvents: 0,
          };
        }

        const activatedAt = existingActivatedAt ?? new Date().toISOString();
        ensureDemoTelemetryPurgeIndexes(this.db);
        this.db.prepare(`DELETE FROM sensor_recorded_measurements AS catalogue
          WHERE EXISTS (
            SELECT 1 FROM measurement_samples AS sample
            WHERE sample.sensor_id = catalogue.sensor_id AND sample.metric = catalogue.metric
              AND sample.source IN ('mock', 'replay')
          ) AND NOT EXISTS (
            SELECT 1 FROM measurement_samples AS sample
            WHERE sample.sensor_id = catalogue.sensor_id AND sample.metric = catalogue.metric
              AND sample.source NOT IN ('mock', 'replay')
          )`).run();
        const measurementSamples = Number(this.db.prepare(
          "DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')",
        ).run().changes);
        const readings = Number(this.db.prepare(
          "DELETE FROM readings WHERE source IN ('mock', 'replay')",
        ).run().changes);
        const outdoorTemperatureSamples = Number(this.db.prepare(
          "DELETE FROM outdoor_temperature_samples WHERE source = 'mock'",
        ).run().changes);
        // Alert events have no source column. Clear them at the one-way boundary
        // so an event or active condition derived from mock samples cannot cross it.
        const alertEvents = Number(this.db.prepare("DELETE FROM alert_events").run().changes);
        this.db.prepare("DELETE FROM alert_evaluation_state").run();
        this.db.prepare("DELETE FROM analytics_daily_findings").run();
        // Cached analytics are evidence-mode specific. Cancel jobs first, then
        // remove immutable demo artifacts in the same transaction as the latch
        // so no process can claim or publish demo work after activation.
        this.db.prepare("DELETE FROM derived_analytics_jobs WHERE data_mode = 'demo'").run();
        this.db.prepare("DELETE FROM derived_analytics_artifacts WHERE data_mode = 'demo'").run();
        this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('data_mode', 'real')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
        this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
        return { activated: true, activatedAt, readings, measurementSamples, outdoorTemperatureSamples, alertEvents };
      });
    },
  purgeSourceLabelledDemoTelemetry(): void {
      this.immediateTransaction(() => {
        ensureDemoTelemetryPurgeIndexes(this.db);
        this.db.prepare(`DELETE FROM sensor_recorded_measurements AS catalogue
          WHERE EXISTS (
            SELECT 1 FROM measurement_samples AS sample
            WHERE sample.sensor_id = catalogue.sensor_id AND sample.metric = catalogue.metric
              AND sample.source IN ('mock', 'replay')
          ) AND NOT EXISTS (
            SELECT 1 FROM measurement_samples AS sample
            WHERE sample.sensor_id = catalogue.sensor_id AND sample.metric = catalogue.metric
              AND sample.source NOT IN ('mock', 'replay')
          )`).run();
        this.db.prepare("DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')").run();
        this.db.prepare("DELETE FROM readings WHERE source IN ('mock', 'replay')").run();
        this.db.prepare("DELETE FROM outdoor_temperature_samples WHERE source = 'mock'").run();
        this.db.prepare("DELETE FROM analytics_daily_findings WHERE data_mode = 'demo'").run();
        this.db.prepare("DELETE FROM derived_analytics_jobs WHERE data_mode = 'demo'").run();
        this.db.prepare("DELETE FROM derived_analytics_artifacts WHERE data_mode = 'demo'").run();
      });
    },
  /** Removes every local producer/runtime artifact from active remote Homes. */
  purgeSharedHomeLocalState(houseId?: string): void {
      this.immediateTransaction(() => {
        const houseFilter = houseId ? "AND house.id = ?" : "";
        const sharedSensorIds = `SELECT sensor.id
          FROM sensors sensor
          JOIN houses house ON house.id = sensor.house_id
          WHERE json_extract(house.stugby_json, '$.ownership') = 'shared'
            AND json_extract(house.stugby_json, '$.syncState') <> 'detached' ${houseFilter}`;
        const parameters = houseId ? [houseId] : [];
        this.db.prepare(`DELETE FROM alert_evaluation_state WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM alert_events WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM alert_rules WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM sensor_data_gaps WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM tapo_history_export_jobs WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM sensor_measurement_bindings WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM sensor_recorded_measurements
          WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM sensor_source_metrics
          WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM measurement_samples
          WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM readings
          WHERE sensor_id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`UPDATE sensors
          SET temperature_entity_id = NULL, humidity_entity_id = NULL, battery_entity_id = NULL,
              tp_link_device_id = NULL, tp_link_connection_id = NULL, measurement_entity_ids_json = '{}'
          WHERE id IN (${sharedSensorIds})`).run(...parameters);
        this.db.prepare(`DELETE FROM opening_state_observations
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM outdoor_temperature_samples
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM weather_outages
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM weather_snapshots
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
        this.db.prepare(`DELETE FROM analytics_daily_findings
          WHERE house_id IN (
            SELECT id FROM houses
            WHERE json_extract(stugby_json, '$.ownership') = 'shared'
              AND json_extract(stugby_json, '$.syncState') <> 'detached' ${houseId ? "AND id = ?" : ""}
          )`).run(...parameters);
      });
    },
  prepareTelemetrySources(sources: Array<MeasurementSample["source"] | Reading["source"]>): void {
      const hasDemo = sources.some((source) => DEMO_TELEMETRY_SOURCES.has(source));
      const hasReal = sources.some((source) => !DEMO_TELEMETRY_SOURCES.has(source));
      if (hasDemo && hasReal) {
        throw new ClimateDataValidationError(409, "MIXED_DATA_MODES", "Demo and real telemetry cannot be ingested in the same batch");
      }
      if (hasDemo && this.isRealDataMode()) {
        throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Demo telemetry is permanently disabled after a real integration or real sample is accepted");
      }
      if (hasReal && !this.isRealDataMode()) this.activateRealDataMode();
    },
  seed(): void {
      const seeded = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get() as { value: string } | undefined;
      if (seeded) return;
      this.immediateTransaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get()) return;

      const now = new Date().toISOString();
      const floors: Floor[] = [
        {
          id: "floor-ground",
          name: "Ground floor",
          type: "ground",
          width: 14,
          height: 10,
          elevation: 0,
          ceilingHeight: 2.8,
          wallHeight: 2.8,
          walls: [
            { id: "g-n", from: { x: 0, y: 0 }, to: { x: 14, y: 0 } },
            { id: "g-e", from: { x: 14, y: 0 }, to: { x: 14, y: 10 } },
            { id: "g-s", from: { x: 14, y: 10 }, to: { x: 0, y: 10 } },
            { id: "g-w", from: { x: 0, y: 10 }, to: { x: 0, y: 0 } },
            { id: "g-mid-v", from: { x: 8, y: 0 }, to: { x: 8, y: 10 } },
            { id: "g-mid-h", from: { x: 8, y: 5 }, to: { x: 14, y: 5 } },
          ],
          rooms: [
            { id: "living", name: "Living room", points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 0, y: 10 }] },
            { id: "kitchen", name: "Kitchen", points: [{ x: 8, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 }, { x: 8, y: 5 }] },
            { id: "utility", name: "Utility", points: [{ x: 8, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 10 }, { x: 8, y: 10 }] },
          ],
        },
        {
          id: "floor-upper",
          name: "Upper floor",
          type: "upper",
          width: 14,
          height: 10,
          elevation: 3,
          ceilingHeight: 2.6,
          wallHeight: 2.6,
          walls: [
            { id: "u-n", from: { x: 0, y: 0 }, to: { x: 14, y: 0 } },
            { id: "u-e", from: { x: 14, y: 0 }, to: { x: 14, y: 10 } },
            { id: "u-s", from: { x: 14, y: 10 }, to: { x: 0, y: 10 } },
            { id: "u-w", from: { x: 0, y: 10 }, to: { x: 0, y: 0 } },
            { id: "u-mid-v", from: { x: 7, y: 0 }, to: { x: 7, y: 10 } },
            { id: "u-mid-h", from: { x: 7, y: 5 }, to: { x: 14, y: 5 } },
          ],
          rooms: [
            { id: "bedroom", name: "Bedroom", points: [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 10 }, { x: 0, y: 10 }] },
            { id: "office", name: "Office", points: [{ x: 7, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 }, { x: 7, y: 5 }] },
            { id: "bathroom", name: "Bathroom", points: [{ x: 7, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 10 }, { x: 7, y: 10 }] },
          ],
        },
      ];
      const sensors: Sensor[] = [
        ["sensor-01", "Living room — window", "floor-ground", "Living room", 1.5, 2, 1.2],
        ["sensor-02", "Living room — hall", "floor-ground", "Living room", 6.5, 7.5, 1.2],
        ["sensor-03", "Kitchen", "floor-ground", "Kitchen", 11, 2.5, 1.3],
        ["sensor-04", "Utility room", "floor-ground", "Utility", 11, 7.5, 1.3],
        ["sensor-05", "Entrance", "floor-ground", "Living room", 4, 8.5, 1.2],
        ["sensor-06", "Bedroom — window", "floor-upper", "Bedroom", 1.5, 2, 4.2],
        ["sensor-07", "Bedroom — hall", "floor-upper", "Bedroom", 5.5, 7.5, 4.2],
        ["sensor-08", "Office", "floor-upper", "Office", 10.5, 2.5, 4.3],
        ["sensor-09", "Bathroom", "floor-upper", "Bathroom", 10.5, 7.5, 4.3],
        ["sensor-10", "Attic access", "floor-upper", "Bathroom", 13, 9, 5.5],
      ].map(([id, name, floorId, room, x, y, z]) => ({
        id: String(id), houseId: "house-main", floorId: String(floorId), name: String(name), room: String(room),
        model: "TP-Link Tapo T310/T315", x: Number(x), y: Number(y), z: Number(z), tags: ["seeded"], enabled: true,
      }));

        this.db.prepare(`INSERT INTO houses
          (id, property_id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run("house-main", DEFAULT_PROPERTY_ID, "My home", "Europe/Helsinki", null, null, null, JSON.stringify(floors), now, now);
        const sensorStatement = this.db.prepare(`INSERT INTO sensors
          (id, house_id, floor_id, name, room_id, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tags_json, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const sensor of sensors) {
          const roomId = floors.find((floor) => floor.id === sensor.floorId)?.rooms
            .find((room) => room.name === sensor.room)?.id ?? null;
          sensorStatement.run(sensor.id, sensor.houseId, sensor.floorId, sensor.name, roomId, sensor.room, sensor.model,
            sensor.x, sensor.y, sensor.z, null, null, null, JSON.stringify(sensor.tags), 1);
        }
        const readingStatement = this.db.prepare(`INSERT INTO readings
          (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const end = Date.now();
        for (let step = 288; step >= 0; step -= 1) {
          const timestamp = new Date(end - step * 5 * 60_000).toISOString();
          for (let index = 0; index < sensors.length; index += 1) {
            const phase = (288 - step) / 288 * Math.PI * 2;
            const temperature = 20.4 + Math.sin(phase - 1.1) * 1.25 + (index % 5) * 0.13 + Math.sin(step * 0.31 + index) * 0.12;
            const bathroomPulse = index === 8 && step > 45 && step < 60 ? 17 * Math.sin((step - 45) / 15 * Math.PI) : 0;
            const humidity = 43 + Math.sin(phase + 0.65) * 5 + (index % 3) * 1.4 + bathroomPulse;
            readingStatement.run(sensors[index]!.id, timestamp, Number(temperature.toFixed(2)), Number(humidity.toFixed(2)), 96 - (index % 8), "mock", "good");
          }
        }
        this.db.prepare(`INSERT INTO alert_rules
          (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled, telegram_enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run("rule-high-humidity", "Persistent high humidity", null, "humidity", "gte", 65, 900, "warning", 1, 1, 0);
        this.db.prepare(`INSERT INTO static_parameters
          (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run("parameter-year-built", "house-main", "house", "house-main", "yearBuilt", JSON.stringify(1998), null, "Year built");
        this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_version', '1')").run();
      });
    },
  close(): void {
      this.closeCostReader();
      // Make file-backed shutdown deterministic on Windows as well as POSIX.
      // Schema-rebuild migrations can otherwise leave a WAL checkpoint pending
      // briefly after DatabaseSync.close(), which prevents immediate backup or
      // test-directory rotation even though the connection is closed.
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.db.exec("PRAGMA journal_mode = DELETE");
      } catch { /* The database may be read-only or already closing. */ }
      this.db.close();
    },
});
