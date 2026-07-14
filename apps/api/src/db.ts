import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AlertEvent,
  AlertRule,
  Floor,
  House,
  HouseLocation,
  HouseMapPlacement,
  ManualObservation,
  MeasurementDefinition,
  MeasurementSample,
  OutdoorTemperatureSample,
  Reading,
  Sensor,
  StaticParameter,
  Wall,
} from "@climate-twin/contracts";

type JsonValue = string | number | boolean;
const MIN_SEED_OUTDOOR_READINGS = 48;
const DEMO_TELEMETRY_SOURCES = new Set<MeasurementSample["source"]>(["mock", "replay"]);

export interface DemoTelemetryPurgeResult {
  activated: boolean;
  activatedAt: string;
  readings: number;
  measurementSamples: number;
  outdoorTemperatureSamples: number;
  alertEvents: number;
}

interface HouseRow {
  id: string;
  name: string;
  timezone: string;
  location_json: string | null;
  map_placement_json: string | null;
  orientation_degrees: number | null;
  floors_json: string;
  created_at: string;
  updated_at: string;
}

interface SensorRow {
  id: string;
  house_id: string;
  floor_id: string;
  name: string;
  room: string;
  model: string;
  x: number;
  y: number;
  z: number;
  temperature_entity_id: string | null;
  humidity_entity_id: string | null;
  battery_entity_id: string | null;
  tp_link_device_id: string | null;
  measurement_entity_ids_json?: string | null;
  tags_json: string;
  enabled: number;
}

interface MeasurementDefinitionRow {
  id: string;
  labels_json: string;
  unit: string;
  precision: number;
  valid_min: number | null;
  valid_max: number | null;
  display_min: number | null;
  display_max: number | null;
  interpolation_delta: number;
  color_scale: MeasurementDefinition["colorScale"];
  builtin: number;
  enabled: number;
  spatial_interpolation: number;
  forecast_supported: number;
}

interface MeasurementSampleRow {
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  timestamp: string;
  source: MeasurementSample["source"];
  quality: MeasurementSample["quality"];
}

interface ReadingRow {
  sensor_id: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: Reading["source"];
  quality: Reading["quality"];
}

interface AlertRuleRow {
  id: string;
  name: string;
  sensor_id: string | null;
  metric: AlertRule["metric"];
  operator: AlertRule["operator"];
  threshold: number;
  duration_seconds: number;
  severity: AlertRule["severity"];
  enabled: number;
  webhook_enabled: number;
}

interface AlertEventRow {
  id: string;
  rule_id: string;
  sensor_id: string;
  metric: AlertEvent["metric"];
  value: number;
  threshold: number;
  severity: AlertEvent["severity"];
  started_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

interface ObservationRow {
  id: string;
  house_id: string;
  floor_id: string;
  sensor_id: string | null;
  kind: ManualObservation["kind"];
  severity: ManualObservation["severity"];
  note: string;
  x: number | null;
  y: number | null;
  occurred_at: string;
  created_at: string;
}

interface StaticParameterRow {
  id: string;
  house_id: string;
  scope_type: StaticParameter["scopeType"];
  scope_id: string;
  key: string;
  value_json: string;
  unit: string | null;
  label: string;
}

interface OutdoorTemperatureRow {
  house_id: string;
  location_key: string;
  timestamp: string;
  temperature_c: number;
  source: OutdoorTemperatureSample["source"];
  fetched_at: string;
  station_id: string | null;
  station_name: string | null;
}

export interface AssetRecord {
  id: string;
  houseId: string;
  name: string;
  mimeType: string;
  kind: "floor-plan" | "model-3d" | "other";
  size: number;
  createdAt: string;
}

export class ClimateDataValidationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SensorUpdate = Partial<Omit<Sensor, "id" | "tpLinkDeviceId">> & {
  /** Set null to remove a persisted direct TP-Link child-device binding. */
  tpLinkDeviceId?: string | null;
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

type LayoutPoint = { x: number; y: number };

function roomPolygonSelfIntersects(points: LayoutPoint[], coordinateScale: number): boolean {
  const linearTolerance = Math.max(1, coordinateScale) * 1e-10;
  const crossTolerance = Math.max(1, coordinateScale * coordinateScale) * 1e-10;
  const cross = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint) => (
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  );
  const onSegment = (a: LayoutPoint, b: LayoutPoint, point: LayoutPoint) => (
    Math.abs(cross(a, b, point)) <= crossTolerance
    && point.x >= Math.min(a.x, b.x) - linearTolerance
    && point.x <= Math.max(a.x, b.x) + linearTolerance
    && point.y >= Math.min(a.y, b.y) - linearTolerance
    && point.y <= Math.max(a.y, b.y) + linearTolerance
  );
  const segmentsIntersect = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint) => {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    const crossesProperly = ((abC > crossTolerance && abD < -crossTolerance) || (abC < -crossTolerance && abD > crossTolerance))
      && ((cdA > crossTolerance && cdB < -crossTolerance) || (cdA < -crossTolerance && cdB > crossTolerance));
    return crossesProperly
      || onSegment(a, b, c)
      || onSegment(a, b, d)
      || onSegment(c, d, a)
      || onSegment(c, d, b);
  };

  for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % points.length;
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
      const secondNext = (secondIndex + 1) % points.length;
      // Consecutive edges are expected to meet at their shared vertex.
      if (firstNext === secondIndex || secondNext === firstIndex) continue;
      if (segmentsIntersect(points[firstIndex]!, points[firstNext]!, points[secondIndex]!, points[secondNext]!)) return true;
    }
  }
  return false;
}

function houseFromRow(row: HouseRow): House {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    ...(row.location_json ? { location: parseJson<HouseLocation>(row.location_json) } : {}),
    ...(row.map_placement_json ? { mapPlacement: parseJson<HouseMapPlacement>(row.map_placement_json) } : {}),
    ...(row.orientation_degrees !== null ? { orientationDegrees: row.orientation_degrees } : {}),
    floors: parseJson<Floor[]>(row.floors_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sensorFromRow(row: SensorRow): Sensor {
  return {
    id: row.id,
    houseId: row.house_id,
    floorId: row.floor_id,
    name: row.name,
    room: row.room,
    model: row.model,
    x: row.x,
    y: row.y,
    z: row.z,
    ...(row.temperature_entity_id ? { temperatureEntityId: row.temperature_entity_id } : {}),
    ...(row.humidity_entity_id ? { humidityEntityId: row.humidity_entity_id } : {}),
    ...(row.battery_entity_id ? { batteryEntityId: row.battery_entity_id } : {}),
    ...(row.tp_link_device_id ? { tpLinkDeviceId: row.tp_link_device_id } : {}),
    tags: parseJson<string[]>(row.tags_json),
    enabled: row.enabled === 1,
  };
}

function measurementDefinitionFromRow(row: MeasurementDefinitionRow): MeasurementDefinition {
  return {
    id: row.id,
    labels: parseJson<Record<string, string>>(row.labels_json),
    unit: row.unit,
    precision: row.precision,
    validMin: row.valid_min,
    validMax: row.valid_max,
    displayMin: row.display_min,
    displayMax: row.display_max,
    interpolationDelta: row.interpolation_delta,
    colorScale: row.color_scale,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1,
    spatialInterpolation: row.spatial_interpolation === 1,
    forecastSupported: row.forecast_supported === 1,
  };
}

function measurementSampleFromRow(row: MeasurementSampleRow): MeasurementSample {
  return {
    sensorId: row.sensor_id,
    metric: row.metric,
    value: row.value,
    canonicalUnit: row.canonical_unit,
    timestamp: row.timestamp,
    source: row.source,
    quality: row.quality,
  };
}

function readingFromRow(row: ReadingRow): Reading {
  return {
    sensorId: row.sensor_id,
    timestamp: row.timestamp,
    temperature: row.temperature,
    humidity: row.humidity,
    battery: row.battery,
    source: row.source,
    quality: row.quality,
  };
}

function ruleFromRow(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    sensorId: row.sensor_id,
    metric: row.metric,
    operator: row.operator,
    threshold: row.threshold,
    durationSeconds: row.duration_seconds,
    severity: row.severity,
    enabled: row.enabled === 1,
    webhookEnabled: row.webhook_enabled === 1,
  };
}

function eventFromRow(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    ruleId: row.rule_id,
    sensorId: row.sensor_id,
    metric: row.metric,
    value: row.value,
    threshold: row.threshold,
    severity: row.severity,
    startedAt: row.started_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };
}

function observationFromRow(row: ObservationRow): ManualObservation {
  return {
    id: row.id,
    houseId: row.house_id,
    floorId: row.floor_id,
    sensorId: row.sensor_id,
    kind: row.kind,
    severity: row.severity,
    note: row.note,
    x: row.x,
    y: row.y,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function parameterFromRow(row: StaticParameterRow): StaticParameter {
  return {
    id: row.id,
    houseId: row.house_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    key: row.key,
    value: parseJson<JsonValue>(row.value_json),
    unit: row.unit,
    label: row.label,
  };
}

function outdoorTemperatureFromRow(row: OutdoorTemperatureRow): OutdoorTemperatureSample {
  return {
    houseId: row.house_id,
    locationKey: row.location_key,
    timestamp: row.timestamp,
    temperatureC: row.temperature_c,
    source: row.source,
    fetchedAt: row.fetched_at,
    stationId: row.station_id,
    stationName: row.station_name,
  };
}

/** Opaque stable key prevents old-location weather entering a new calibration. */
export function outdoorLocationKey(location?: HouseLocation): string {
  if (!location) return "unlocated";
  const normalized = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
  return `geo:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export class ClimateDatabase {
  readonly db: DatabaseSync;

  constructor(path: string, seed = true) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    const realDataMode = this.isRealDataMode();
    // Never seed a database that has crossed the one-way boundary, including
    // partially restored databases whose seed metadata is missing.
    if (seed && !realDataMode) this.seed();
    if (realDataMode) this.purgeSourceLabelledDemoTelemetry();
    this.backfillLegacyMeasurements();
    if (seed && !realDataMode) this.backfillSeedOutdoorTemperature();
    // A persisted real-data latch is authoritative even if a database was
    // modified outside the application while it was stopped.
    if (this.isRealDataMode()) this.purgeSourceLabelledDemoTelemetry();
  }

  isRealDataMode(): boolean {
    return (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value === "real";
  }

  realDataModeActivatedAt(): string | null {
    if (!this.isRealDataMode()) return null;
    return (this.db.prepare("SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'").get() as { value: string } | undefined)?.value ?? null;
  }

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
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('data_mode', 'real')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
      this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
      return { activated: true, activatedAt, readings, measurementSamples, outdoorTemperatureSamples, alertEvents };
    });
  }

  private purgeSourceLabelledDemoTelemetry(): void {
    this.immediateTransaction(() => {
      this.db.prepare("DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')").run();
      this.db.prepare("DELETE FROM readings WHERE source IN ('mock', 'replay')").run();
      this.db.prepare("DELETE FROM outdoor_temperature_samples WHERE source = 'mock'").run();
    });
  }

  private prepareTelemetrySources(sources: Array<MeasurementSample["source"] | Reading["source"]>): void {
    const hasDemo = sources.some((source) => DEMO_TELEMETRY_SOURCES.has(source));
    const hasReal = sources.some((source) => !DEMO_TELEMETRY_SOURCES.has(source));
    if (hasDemo && hasReal) {
      throw new ClimateDataValidationError(409, "MIXED_DATA_MODES", "Demo and real telemetry cannot be ingested in the same batch");
    }
    if (hasDemo && this.isRealDataMode()) {
      throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Demo telemetry is permanently disabled after a real integration or real sample is accepted");
    }
    if (hasReal && !this.isRealDataMode()) this.activateRealDataMode();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS houses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        location_json TEXT,
        map_placement_json TEXT,
        orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360),
        floors_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sensors (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        room TEXT NOT NULL,
        model TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        temperature_entity_id TEXT,
        humidity_entity_id TEXT,
        battery_entity_id TEXT,
        tp_link_device_id TEXT,
        measurement_entity_ids_json TEXT,
        tags_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        temperature REAL NOT NULL,
        humidity REAL NOT NULL,
        battery REAL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_readings_sensor_time
        ON readings(sensor_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_readings_time
        ON readings(timestamp, id);
      CREATE TABLE IF NOT EXISTS measurement_definitions (
        id TEXT PRIMARY KEY,
        labels_json TEXT NOT NULL,
        unit TEXT NOT NULL,
        precision INTEGER NOT NULL,
        valid_min REAL,
        valid_max REAL,
        display_min REAL,
        display_max REAL,
        interpolation_delta REAL NOT NULL,
        color_scale TEXT NOT NULL,
        builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        spatial_interpolation INTEGER NOT NULL CHECK (spatial_interpolation IN (0, 1)),
        forecast_supported INTEGER NOT NULL CHECK (forecast_supported IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS measurement_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id),
        value REAL NOT NULL,
        canonical_unit TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL,
        UNIQUE(sensor_id, metric, timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_measurement_samples_sensor_metric_time
        ON measurement_samples(sensor_id, metric, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_measurement_samples_time
        ON measurement_samples(timestamp, id);
      CREATE TABLE IF NOT EXISTS sensor_measurement_bindings (
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id),
        entity_id TEXT NOT NULL,
        PRIMARY KEY(sensor_id, metric)
      );
      CREATE INDEX IF NOT EXISTS idx_sensor_measurement_bindings_entity
        ON sensor_measurement_bindings(entity_id);
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sensor_id TEXT REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        severity TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        webhook_enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        threshold REAL NOT NULL,
        severity TEXT NOT NULL,
        started_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_events_started ON alert_events(started_at DESC);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        sensor_id TEXT REFERENCES sensors(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        note TEXT NOT NULL,
        x REAL,
        y REAL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS static_parameters (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        unit TEXT,
        label TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_parameters_scope_key
        ON static_parameters(house_id, scope_type, scope_id, key);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        data BLOB NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outdoor_temperature_samples (
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        location_key TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        temperature_c REAL NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        station_id TEXT,
        station_name TEXT,
        PRIMARY KEY(house_id, location_key, timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_outdoor_temperature_house_location_time
        ON outdoor_temperature_samples(house_id, location_key, timestamp);
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_insert_in_real_mode
        BEFORE INSERT ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_update_in_real_mode
        BEFORE UPDATE OF source ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_insert_in_real_mode
        BEFORE INSERT ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_update_in_real_mode
        BEFORE UPDATE OF source ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_outdoor_insert_in_real_mode
        BEFORE INSERT ON outdoor_temperature_samples
        WHEN NEW.source = 'mock'
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_outdoor_update_in_real_mode
        BEFORE UPDATE OF source ON outdoor_temperature_samples
        WHEN NEW.source = 'mock'
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
    `);
    const houseColumns = this.db.prepare("PRAGMA table_info(houses)").all() as unknown as Array<{ name: string }>;
    if (!houseColumns.some((column) => column.name === "location_json")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN location_json TEXT");
    }
    if (!houseColumns.some((column) => column.name === "map_placement_json")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN map_placement_json TEXT");
    }
    if (!houseColumns.some((column) => column.name === "orientation_degrees")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360)");
    }
    const sensorColumns = this.db.prepare("PRAGMA table_info(sensors)").all() as unknown as Array<{ name: string }>;
    if (!sensorColumns.some((column) => column.name === "measurement_entity_ids_json")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN measurement_entity_ids_json TEXT");
    }
    if (!sensorColumns.some((column) => column.name === "tp_link_device_id")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_device_id TEXT");
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sensors_tp_link_device
      ON sensors(tp_link_device_id) WHERE tp_link_device_id IS NOT NULL`);
    const insertDefinition = this.db.prepare(`INSERT OR IGNORE INTO measurement_definitions
      (id, labels_json, unit, precision, valid_min, valid_max, display_min, display_max, interpolation_delta,
       color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`);
    insertDefinition.run("temperature", JSON.stringify({ en: "Temperature", fi: "Lämpötila" }), "°C", 1, -80, 100, 15, 30, 2, "thermal");
    insertDefinition.run("humidity", JSON.stringify({ en: "Humidity", fi: "Ilmankosteus" }), "%", 0, 0, 100, 20, 80, 10, "humidity");
    insertDefinition.run("co2", JSON.stringify({ en: "Carbon dioxide", fi: "Hiilidioksidi" }), "ppm", 0, 0, 10_000, 400, 2_000, 250, "air-quality");
    this.migrateOutdoorLocationKeys();
    this.migrateSensorMeasurementBindings();
    const readingIdentityMigration = this.db.prepare("SELECT value FROM metadata WHERE key = 'reading_identity_v1'").get();
    if (!readingIdentityMigration) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          DELETE FROM readings
          WHERE id NOT IN (SELECT MAX(id) FROM readings GROUP BY sensor_id, timestamp, source);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_identity
            ON readings(sensor_id, timestamp, source);
          INSERT INTO metadata(key, value) VALUES ('reading_identity_v1', 'complete');
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private migrateOutdoorLocationKeys(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'outdoor_location_keys_v2'").get();
    if (migrated) return;
    this.immediateTransaction(() => {
      const houses = this.db.prepare("SELECT id, location_json FROM houses").all() as unknown as Array<{
        id: string;
        location_json: string | null;
      }>;
      const rekey = this.db.prepare(`UPDATE OR REPLACE outdoor_temperature_samples
        SET location_key = ? WHERE house_id = ? AND location_key = ?`);
      const prune = this.db.prepare(`DELETE FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key <> ?`);
      for (const house of houses) {
        let location: HouseLocation | undefined;
        try {
          location = house.location_json ? JSON.parse(house.location_json) as HouseLocation : undefined;
        } catch {
          location = undefined;
        }
        const allowedKey = outdoorLocationKey(location);
        if (location) {
          const legacyKey = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
          rekey.run(allowedKey, house.id, legacyKey);
        }
        // Removes precise historical coordinates and every superseded location.
        prune.run(house.id, allowedKey);
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('outdoor_location_keys_v2', 'complete')").run();
    });
  }

  private backfillLegacyMeasurements(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'measurement_eav_v2'").get();
    if (migrated) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        INSERT OR IGNORE INTO measurement_samples
          (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        SELECT sensor_id, 'temperature', temperature, '°C', timestamp, source, quality FROM readings;
        INSERT OR IGNORE INTO measurement_samples
          (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        SELECT sensor_id, 'humidity', humidity, '%', timestamp, source, quality FROM readings;
        INSERT INTO metadata(key, value) VALUES ('measurement_eav_v2', 'complete');
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Gives the bundled demo an explicitly synthetic outdoor boundary so the physics UI is testable.
   * It is never used for a geolocated house and is labelled `mock` in every result.
   */
  private backfillSeedOutdoorTemperature(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_outdoor_temperature_v1'").get();
    if (migrated) return;
    const house = this.getHouse("house-main");
    const existing = house
      ? this.db.prepare("SELECT 1 FROM outdoor_temperature_samples WHERE house_id = ? LIMIT 1").get(house.id)
      : null;
    if (house && !house.location && !existing) {
      const readings = this.db.prepare(`SELECT timestamp, temperature FROM readings
        WHERE sensor_id = 'sensor-01' AND source = 'mock' ORDER BY timestamp ASC, id ASC`)
        .all() as unknown as Array<{ timestamp: string; temperature: number }>;
      if (readings.length > MIN_SEED_OUTDOOR_READINGS) {
        const tauHours = 8;
        const liftC = 16;
        const insert = this.db.prepare(`INSERT OR IGNORE INTO outdoor_temperature_samples
          (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
          VALUES (?, ?, ?, ?, 'mock', ?, NULL, ?)`);
        let lastOutdoorC = readings[0]?.temperature ?? 0;
        for (let index = 0; index < readings.length - 1; index += 1) {
          const current = readings[index];
          const next = readings[index + 1];
          if (!current || !next) continue;
          const dtHours = (Date.parse(next.timestamp) - Date.parse(current.timestamp)) / 3_600_000;
          if (!(dtHours > 0)) continue;
          const memory = Math.exp(-dtHours / tauHours);
          lastOutdoorC = (next.temperature - memory * current.temperature) / (1 - memory) - liftC;
          insert.run(house.id, outdoorLocationKey(), current.timestamp, lastOutdoorC, current.timestamp, "Synthetic demo boundary");
        }
        const latest = readings.at(-1);
        if (latest) insert.run(house.id, outdoorLocationKey(), latest.timestamp, lastOutdoorC, latest.timestamp, "Synthetic demo boundary");
      }
    }
    this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_outdoor_temperature_v1', 'complete')").run();
  }

  private migrateSensorMeasurementBindings(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_measurement_bindings_v2'").get();
    if (migrated) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT id, measurement_entity_ids_json, temperature_entity_id, humidity_entity_id
        FROM sensors`).all() as unknown as Array<{
          id: string;
          measurement_entity_ids_json: string | null;
          temperature_entity_id: string | null;
          humidity_entity_id: string | null;
        }>;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO sensor_measurement_bindings(sensor_id, metric, entity_id)
        VALUES (?, ?, ?)`);
      for (const row of rows) {
        const bindings = row.measurement_entity_ids_json ? parseJson<Record<string, string>>(row.measurement_entity_ids_json) : {};
        if (row.temperature_entity_id) bindings.temperature ??= row.temperature_entity_id;
        if (row.humidity_entity_id) bindings.humidity ??= row.humidity_entity_id;
        for (const [metric, entityId] of Object.entries(bindings)) {
          if (this.getMeasurementDefinition(metric)) insert.run(row.id, metric, entityId);
        }
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('sensor_measurement_bindings_v2', 'complete')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  seed(): void {
    const seeded = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get() as { value: string } | undefined;
    if (seeded) return;

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

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO houses
        (id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("house-main", "My home", "Europe/Helsinki", null, null, null, JSON.stringify(floors), now, now);
      const sensorStatement = this.db.prepare(`INSERT INTO sensors
        (id, house_id, floor_id, name, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tags_json, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const sensor of sensors) {
        sensorStatement.run(sensor.id, sensor.houseId, sensor.floorId, sensor.name, sensor.room, sensor.model,
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
        (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("rule-high-humidity", "Persistent high humidity", null, "humidity", "gte", 65, 900, "warning", 1, 1);
      this.db.prepare(`INSERT INTO static_parameters
        (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("parameter-year-built", "house-main", "house", "house-main", "yearBuilt", JSON.stringify(1998), null, "Year built");
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_version', '1')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  listHouses(): House[] {
    const rows = this.db.prepare("SELECT * FROM houses ORDER BY name").all() as unknown as HouseRow[];
    return rows.map(houseFromRow);
  }

  getHouse(id: string): House | null {
    const row = this.db.prepare("SELECT * FROM houses WHERE id = ?").get(id) as unknown as HouseRow | undefined;
    return row ? houseFromRow(row) : null;
  }

  createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
    id?: string;
    location?: HouseLocation;
    mapPlacement?: HouseMapPlacement;
    orientationDegrees?: number;
  }): House {
    this.validateFloorDefinitions(input.floors);
    this.validateHouseTimezone(input.timezone);
    if (input.location) this.validateHouseLocation(input.location);
    if (input.mapPlacement) this.validateHouseMapPlacement(input.mapPlacement, input.floors);
    if (input.orientationDegrees !== undefined) this.validateHouseOrientation(input.orientationDegrees);
    const timestamp = new Date().toISOString();
    const house: House = {
      id: input.id ?? randomUUID(), name: input.name, timezone: input.timezone,
      ...(input.location ? { location: input.location } : {}),
      ...(input.mapPlacement ? { mapPlacement: input.mapPlacement } : {}),
      ...(input.orientationDegrees !== undefined ? { orientationDegrees: input.orientationDegrees } : {}),
      floors: input.floors,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO houses
      (id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(house.id, house.name, house.timezone, house.location ? JSON.stringify(house.location) : null,
        house.mapPlacement ? JSON.stringify(house.mapPlacement) : null,
        house.orientationDegrees ?? null,
        JSON.stringify(house.floors), house.createdAt, house.updatedAt);
    return house;
  }

  updateHouse(
    id: string,
    patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
      location?: HouseLocation | null;
      mapPlacement?: HouseMapPlacement | null;
      orientationDegrees?: number | null;
    },
  ): House | null {
    return this.immediateTransaction(() => {
      const current = this.getHouse(id);
      if (!current) return null;
      // Apply nullable optional fields explicitly so `null` never leaks into
      // the public House contract (absence is represented by omission).
      const next: House = { ...current, id, updatedAt: new Date().toISOString() };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.timezone !== undefined) {
        // A legacy database may contain a timezone accepted by an older build.
        // Preserve that value when an unrelated full-form update echoes it, but
        // validate every newly introduced timezone.
        if (patch.timezone !== current.timezone) this.validateHouseTimezone(patch.timezone);
        next.timezone = patch.timezone;
      }
      if (patch.floors !== undefined) next.floors = patch.floors;
      if (patch.orientationDegrees === null) delete next.orientationDegrees;
      else if (patch.orientationDegrees !== undefined) next.orientationDegrees = patch.orientationDegrees;
      if (patch.location === null) delete next.location;
      else if (patch.location !== undefined) next.location = patch.location;
      if (patch.mapPlacement === null) delete next.mapPlacement;
      else if (patch.mapPlacement !== undefined) next.mapPlacement = patch.mapPlacement;
      if (next.location) this.validateHouseLocation(next.location);
      if (next.orientationDegrees !== undefined) this.validateHouseOrientation(next.orientationDegrees);
      this.validateFloorDefinitions(next.floors);
      if (next.mapPlacement) this.validateHouseMapPlacement(next.mapPlacement, next.floors);
      this.validateHouseLayoutForSensors(id, next.floors);
      this.db.prepare("UPDATE houses SET name = ?, timezone = ?, location_json = ?, map_placement_json = ?, orientation_degrees = ?, floors_json = ?, updated_at = ? WHERE id = ?")
        .run(next.name, next.timezone, next.location ? JSON.stringify(next.location) : null,
          next.mapPlacement ? JSON.stringify(next.mapPlacement) : null,
          next.orientationDegrees ?? null,
          JSON.stringify(next.floors), next.updatedAt, id);
      if (patch.location !== undefined && outdoorLocationKey(current.location) !== outdoorLocationKey(next.location)) {
        this.db.prepare("DELETE FROM outdoor_temperature_samples WHERE house_id = ?").run(id);
      }
      return next;
    });
  }

  deleteHouse(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM houses WHERE id = ?").run(id).changes) > 0;
  }

  listSensors(houseId?: string): Sensor[] {
    const rows = (houseId
      ? this.db.prepare("SELECT * FROM sensors WHERE house_id = ? ORDER BY name").all(houseId)
      : this.db.prepare("SELECT * FROM sensors ORDER BY name").all()) as unknown as SensorRow[];
    return rows.map((row) => this.sensorWithMeasurementBindings(row));
  }

  getSensor(id: string): Sensor | null {
    const row = this.db.prepare("SELECT * FROM sensors WHERE id = ?").get(id) as unknown as SensorRow | undefined;
    return row ? this.sensorWithMeasurementBindings(row) : null;
  }

  private sensorWithMeasurementBindings(row: SensorRow): Sensor {
    const sensor = sensorFromRow(row);
    const bindings = this.db.prepare("SELECT metric, entity_id FROM sensor_measurement_bindings WHERE sensor_id = ? ORDER BY metric")
      .all(sensor.id) as unknown as Array<{ metric: string; entity_id: string }>;
    return bindings.length > 0
      ? { ...sensor, measurementEntityIds: Object.fromEntries(bindings.map((binding) => [binding.metric, binding.entity_id])) }
      : sensor;
  }

  createSensor(input: Omit<Sensor, "id"> & { id?: string }): Sensor {
    const sensor: Sensor = { ...input, id: input.id ?? randomUUID() };
    return this.immediateTransaction(() => {
      this.validateSensorPlacement(sensor);
      this.validateTpLinkDeviceBinding(sensor);
      this.writeSensor(sensor, true);
      return sensor;
    });
  }

  updateSensor(id: string, patch: SensorUpdate): Sensor | null {
    return this.immediateTransaction(() => {
      const current = this.getSensor(id);
      if (!current) return null;
      const { tpLinkDeviceId, ...fields } = patch;
      const sensor: Sensor = { ...current, ...fields, id };
      if (tpLinkDeviceId === null) delete sensor.tpLinkDeviceId;
      else if (tpLinkDeviceId !== undefined) sensor.tpLinkDeviceId = tpLinkDeviceId;
      this.validateSensorPlacement(sensor);
      this.validateTpLinkDeviceBinding(sensor);
      this.writeSensor(sensor, false);
      return sensor;
    });
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private validateFloorDefinitions(floors: Floor[]): void {
    if (!Array.isArray(floors)) {
      throw new ClimateDataValidationError(400, "INVALID_FLOORS", "floors must be an array");
    }
    const ids = new Set<string>();
    for (const floor of floors) {
      if (!floor || typeof floor.id !== "string" || floor.id.trim() === "") {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR", "Every floor must have a non-empty id");
      }
      if (ids.has(floor.id)) {
        throw new ClimateDataValidationError(400, "DUPLICATE_FLOOR", `Floor id ${floor.id} is duplicated`);
      }
      ids.add(floor.id);
      if (!Number.isFinite(floor.width) || floor.width <= 0 || !Number.isFinite(floor.height) || floor.height <= 0) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_EXTENT", `Floor ${floor.id} width and height must be positive finite numbers`);
      }
      if (!Number.isFinite(floor.elevation)) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_ELEVATION", `Floor ${floor.id} elevation must be finite`);
      }
      if (floor.type !== undefined && !["basement", "ground", "upper", "attic", "mezzanine", "outdoor"].includes(floor.type)) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_TYPE", `Floor ${floor.id} has an unsupported type`);
      }
      if (floor.ceilingHeight !== undefined && (!Number.isFinite(floor.ceilingHeight) || floor.ceilingHeight <= 0)) {
        throw new ClimateDataValidationError(400, "INVALID_CEILING_HEIGHT", `Floor ${floor.id} ceilingHeight must be a positive finite number`);
      }
      const pointIsValid = (point: { x: number; y: number } | null | undefined) => Boolean(
        point && Number.isFinite(point.x) && Number.isFinite(point.y)
        && point.x >= 0 && point.x <= floor.width && point.y >= 0 && point.y <= floor.height,
      );
      if (!Array.isArray(floor.walls)) {
        throw new ClimateDataValidationError(400, "INVALID_WALLS", `Floor ${floor.id} walls must be an array`);
      }
      const wallsById = new Map<string, Wall>();
      for (const wall of floor.walls) {
        if (!wall || typeof wall.id !== "string" || wall.id.trim() === "" || wallsById.has(wall.id)) {
          throw new ClimateDataValidationError(400, "INVALID_WALL_ID", `Floor ${floor.id} walls must have unique non-empty ids`);
        }
        if (!pointIsValid(wall.from) || !pointIsValid(wall.to)
          || (Math.abs(wall.from.x - wall.to.x) < 1e-10 && Math.abs(wall.from.y - wall.to.y) < 1e-10)) {
          throw new ClimateDataValidationError(400, "INVALID_WALL_GEOMETRY", `Floor ${floor.id} walls must have distinct in-bounds endpoints`);
        }
        wallsById.set(wall.id, wall);
      }
      if (!Array.isArray(floor.rooms)) {
        throw new ClimateDataValidationError(400, "INVALID_ROOMS", `Floor ${floor.id} rooms must be an array`);
      }
      const roomIds = new Set<string>();
      const roomNames = new Set<string>();
      for (const room of floor.rooms) {
        if (!room || typeof room.id !== "string" || room.id.trim() === "" || roomIds.has(room.id)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_ID", `Floor ${floor.id} rooms must have unique non-empty ids`);
        }
        roomIds.add(room.id);
        if (typeof room.name !== "string" || room.name.trim() === "") {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_NAME", `Floor ${floor.id} rooms must have non-empty names`);
        }
        const normalizedRoomName = room.name.trim().normalize("NFKC").toLowerCase();
        if (roomNames.has(normalizedRoomName)) {
          throw new ClimateDataValidationError(400, "DUPLICATE_ROOM_NAME", `Floor ${floor.id} room names must be unique, ignoring case`);
        }
        roomNames.add(normalizedRoomName);
        if (!Array.isArray(room.points) || room.points.length < 3 || !room.points.every(pointIsValid)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons need at least three in-bounds points`);
        }
        const distinctPoints = new Set(room.points.map((point) => `${point.x}:${point.y}`));
        const doubledArea = Math.abs(room.points.reduce((area, point, index) => {
          const next = room.points[(index + 1) % room.points.length]!;
          return area + point.x * next.y - next.x * point.y;
        }, 0));
        if (distinctPoints.size !== room.points.length || doubledArea < 1e-10) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons must use distinct vertices and enclose a non-zero area`);
        }
        if (roomPolygonSelfIntersects(room.points, Math.max(floor.width, floor.height))) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons cannot self-intersect`);
        }
      }
      if (floor.planElements !== undefined) {
        if (!Array.isArray(floor.planElements)) {
          throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENTS", `Floor ${floor.id} planElements must be an array`);
        }
        const elementIds = new Set<string>();
        for (const element of floor.planElements) {
          if (!element || typeof element.id !== "string" || element.id.trim() === "" || elementIds.has(element.id)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ID", `Floor ${floor.id} plan elements must have unique non-empty ids`);
          }
          elementIds.add(element.id);
          if (!["door", "window", "fireplace", "vent"].includes(element.kind)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_KIND", `Floor ${floor.id} has an unsupported plan element kind`);
          }
          if (!element.position || !Number.isFinite(element.position.x) || !Number.isFinite(element.position.y)
            || element.position.x < 0 || element.position.x > floor.width || element.position.y < 0 || element.position.y > floor.height) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_POSITION", `Floor ${floor.id} plan element positions must be within its extent`);
          }
          if (!Number.isFinite(element.rotationDegrees) || element.rotationDegrees < 0 || element.rotationDegrees >= 360) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ROTATION", `Floor ${floor.id} plan element rotations must be from 0 (inclusive) to 360 (exclusive)`);
          }
          if (element.width !== undefined && (!Number.isFinite(element.width) || element.width <= 0)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WIDTH", `Floor ${floor.id} plan element widths must be positive finite numbers`);
          }
          const isOpening = element.kind === "door" || element.kind === "window";
          if (isOpening && (typeof element.wallId !== "string" || !wallsById.has(element.wallId))) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WALL", `Floor ${floor.id} doors and windows must reference an existing wall`);
          }
          if (!isOpening && element.wallId !== undefined) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WALL", `Floor ${floor.id} fireplaces and vents cannot be attached as wall openings`);
          }
          if (isOpening) {
            const wall = wallsById.get(element.wallId!);
            if (!wall) continue;
            const dx = wall.to.x - wall.from.x;
            const dy = wall.to.y - wall.from.y;
            const lengthSquared = dx * dx + dy * dy;
            const progress = Math.max(0, Math.min(1, ((element.position.x - wall.from.x) * dx + (element.position.y - wall.from.y) * dy) / lengthSquared));
            const projectedX = wall.from.x + progress * dx;
            const projectedY = wall.from.y + progress * dy;
            const tolerance = Math.max(floor.width, floor.height, 1) * 1e-7;
            const wallAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
            const rotationDelta = ((element.rotationDegrees - wallAngle) % 180 + 180) % 180;
            if (Math.hypot(element.position.x - projectedX, element.position.y - projectedY) > tolerance
              || Math.min(rotationDelta, 180 - rotationDelta) > 1e-6) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ALIGNMENT", `Floor ${floor.id} doors and windows must lie on and align with their wall`);
            }
            if (element.width !== undefined) {
              const wallLength = Math.sqrt(lengthSquared);
              const halfWidth = element.width / 2;
              const distanceFromStart = progress * wallLength;
              const distanceFromEnd = wallLength - distanceFromStart;
              if (element.width > wallLength + tolerance
                || distanceFromStart + tolerance < halfWidth
                || distanceFromEnd + tolerance < halfWidth) {
                throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_FIT", `Floor ${floor.id} door and window widths must fit fully within their wall`);
              }
            }
          }
        }
      }
    }
  }

  private validateHouseLocation(location: HouseLocation): void {
    if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
      throw new ClimateDataValidationError(422, "INVALID_LATITUDE", "House latitude must be between -90 and 90");
    }
    if (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
      throw new ClimateDataValidationError(422, "INVALID_LONGITUDE", "House longitude must be between -180 and 180");
    }
    if (location.label !== undefined && (typeof location.label !== "string" || location.label.trim().length > 200)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_LABEL", "House location label must be at most 200 characters");
    }
    if (location.countryCode !== undefined && !/^[A-Z]{2}$/.test(location.countryCode)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_COUNTRY", "House location countryCode must be a two-letter uppercase code");
    }
    if (location.source !== undefined && !["manual", "place-search", "browser-geolocation", "home-assistant", "map-placement"].includes(location.source)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_SOURCE", "House location source is not supported");
    }
    if (location.confidence !== undefined && !["high", "medium", "low"].includes(location.confidence)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_CONFIDENCE", "House location confidence is not supported");
    }
    if (location.discoveredAt !== undefined && !Number.isFinite(Date.parse(location.discoveredAt))) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_DISCOVERED_AT", "House location discoveredAt must be an ISO date-time");
    }
    if (location.userOverridden !== undefined && typeof location.userOverridden !== "boolean") {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_OVERRIDE", "House location userOverridden must be a boolean");
    }
  }

  private validateHouseTimezone(timezone: string): void {
    if (typeof timezone !== "string" || timezone.length > 100) {
      throw new ClimateDataValidationError(422, "INVALID_TIMEZONE", "House timezone must be a valid IANA timezone name");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      throw new ClimateDataValidationError(422, "INVALID_TIMEZONE", "House timezone must be a valid IANA timezone name");
    }
  }

  private validateHouseMapPlacement(mapPlacement: HouseMapPlacement, floors: Floor[]): void {
    if (!Number.isFinite(mapPlacement.latitude) || mapPlacement.latitude < -90 || mapPlacement.latitude > 90) {
      throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_LATITUDE", "Map placement latitude must be between -90 and 90");
    }
    if (!Number.isFinite(mapPlacement.longitude) || mapPlacement.longitude < -180 || mapPlacement.longitude > 180) {
      throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_LONGITUDE", "Map placement longitude must be between -180 and 180");
    }
    if (!Number.isFinite(mapPlacement.metersPerPlanUnit) || mapPlacement.metersPerPlanUnit <= 0) {
      throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_SCALE", "Map placement metersPerPlanUnit must be a positive finite number");
    }
    if (mapPlacement.footprintFloorId !== undefined) {
      if (typeof mapPlacement.footprintFloorId !== "string" || mapPlacement.footprintFloorId.trim() === "") {
        throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_FLOOR", "Map placement footprintFloorId must be a non-empty floor id");
      }
      if (!floors.some((floor) => floor.id === mapPlacement.footprintFloorId)) {
        throw new ClimateDataValidationError(
          422,
          "MAP_PLACEMENT_FLOOR_NOT_FOUND",
          `Map placement footprint floor ${mapPlacement.footprintFloorId} does not exist in this house`,
        );
      }
    }
  }

  private validateHouseOrientation(orientationDegrees: number): void {
    if (!Number.isFinite(orientationDegrees) || orientationDegrees < 0 || orientationDegrees >= 360) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_ORIENTATION",
        "House orientationDegrees must be a finite compass bearing from 0 (inclusive) to 360 (exclusive)",
      );
    }
  }

  private validateHouseLayoutForSensors(houseId: string, floors: Floor[]): void {
    const floorsById = new Map(floors.map((floor) => [floor.id, floor]));
    for (const sensor of this.listSensors(houseId)) {
      const floor = floorsById.get(sensor.floorId);
      if (!floor) {
        throw new ClimateDataValidationError(409, "LAYOUT_ORPHANS_SENSOR", `Floor ${sensor.floorId} cannot be removed while sensor ${sensor.id} uses it`);
      }
      if (sensor.x < 0 || sensor.x > floor.width || sensor.y < 0 || sensor.y > floor.height) {
        throw new ClimateDataValidationError(409, "LAYOUT_EXCLUDES_SENSOR", `Floor ${floor.id} extent would exclude sensor ${sensor.id}`);
      }
    }
  }

  private validateSensorPlacement(sensor: Sensor): void {
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
  }

  private validateTpLinkDeviceBinding(sensor: Sensor): void {
    if (sensor.tpLinkDeviceId === undefined) return;
    if (!sensor.tpLinkDeviceId.trim() || sensor.tpLinkDeviceId !== sensor.tpLinkDeviceId.trim()) {
      throw new ClimateDataValidationError(
        400,
        "INVALID_TP_LINK_DEVICE_ID",
        "tpLinkDeviceId must be a non-empty trimmed string",
      );
    }
    const existing = this.db.prepare("SELECT id FROM sensors WHERE tp_link_device_id = ? AND id <> ?")
      .get(sensor.tpLinkDeviceId, sensor.id) as unknown as { id: string } | undefined;
    if (existing) {
      throw new ClimateDataValidationError(
        409,
        "TP_LINK_DEVICE_ALREADY_MAPPED",
        `TP-Link child device ${sensor.tpLinkDeviceId} is already mapped to sensor ${existing.id}`,
      );
    }
  }

  private writeSensor(sensor: Sensor, insert: boolean): void {
    const bindings: Record<string, string> = { ...(sensor.measurementEntityIds ?? {}) };
    if (sensor.temperatureEntityId) bindings.temperature ??= sensor.temperatureEntityId;
    if (sensor.humidityEntityId) bindings.humidity ??= sensor.humidityEntityId;
    for (const metric of Object.keys(bindings)) {
      if (!this.getMeasurementDefinition(metric)) {
        throw new ClimateDataValidationError(422, "UNKNOWN_METRIC", `Unknown measurement metric binding: ${metric}`);
      }
    }
    const values = [sensor.houseId, sensor.floorId, sensor.name, sensor.room, sensor.model, sensor.x, sensor.y, sensor.z,
      sensor.temperatureEntityId ?? null, sensor.humidityEntityId ?? null, sensor.batteryEntityId ?? null,
      sensor.tpLinkDeviceId ?? null,
      null,
      JSON.stringify(sensor.tags), sensor.enabled ? 1 : 0, sensor.id];
    if (insert) {
      this.db.prepare(`INSERT INTO sensors
        (house_id, floor_id, name, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tp_link_device_id,
         measurement_entity_ids_json, tags_json, enabled, id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values);
    } else {
      this.db.prepare(`UPDATE sensors SET house_id = ?, floor_id = ?, name = ?, room = ?, model = ?, x = ?, y = ?, z = ?,
        temperature_entity_id = ?, humidity_entity_id = ?, battery_entity_id = ?, tp_link_device_id = ?, measurement_entity_ids_json = ?,
        tags_json = ?, enabled = ? WHERE id = ?`)
        .run(...values);
    }
    this.db.prepare("DELETE FROM sensor_measurement_bindings WHERE sensor_id = ?").run(sensor.id);
    const insertBinding = this.db.prepare("INSERT INTO sensor_measurement_bindings(sensor_id, metric, entity_id) VALUES (?, ?, ?)");
    for (const [metric, entityId] of Object.entries(bindings)) insertBinding.run(sensor.id, metric, entityId);
  }

  deleteSensor(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM sensors WHERE id = ?").run(id).changes) > 0;
  }

  listMeasurementDefinitions(includeDisabled = true): MeasurementDefinition[] {
    const rows = (includeDisabled
      ? this.db.prepare("SELECT * FROM measurement_definitions ORDER BY builtin DESC, id").all()
      : this.db.prepare("SELECT * FROM measurement_definitions WHERE enabled = 1 ORDER BY builtin DESC, id").all()) as unknown as MeasurementDefinitionRow[];
    return rows.map(measurementDefinitionFromRow);
  }

  getMeasurementDefinition(id: string): MeasurementDefinition | null {
    const row = this.db.prepare("SELECT * FROM measurement_definitions WHERE id = ?").get(id) as unknown as MeasurementDefinitionRow | undefined;
    return row ? measurementDefinitionFromRow(row) : null;
  }

  createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
    this.db.prepare(`INSERT INTO measurement_definitions
      (id, labels_json, unit, precision, valid_min, valid_max, display_min, display_max, interpolation_delta,
       color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(definition.id, JSON.stringify(definition.labels), definition.unit, definition.precision,
        definition.validMin, definition.validMax, definition.displayMin, definition.displayMax,
        definition.interpolationDelta, definition.colorScale, definition.builtin ? 1 : 0, definition.enabled ? 1 : 0,
        definition.spatialInterpolation ? 1 : 0, definition.forecastSupported ? 1 : 0);
    return definition;
  }

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
    this.db.prepare(`UPDATE measurement_definitions SET labels_json = ?, unit = ?, precision = ?, valid_min = ?, valid_max = ?,
      display_min = ?, display_max = ?, interpolation_delta = ?, color_scale = ?, enabled = ?, spatial_interpolation = ?,
      forecast_supported = ? WHERE id = ?`)
      .run(JSON.stringify(next.labels), next.unit, next.precision, next.validMin, next.validMax, next.displayMin,
        next.displayMax, next.interpolationDelta, next.colorScale, next.enabled ? 1 : 0,
        next.spatialInterpolation ? 1 : 0, next.forecastSupported ? 1 : 0, id);
    return next;
  }

  disableMeasurementDefinition(id: string): MeasurementDefinition | null {
    const current = this.getMeasurementDefinition(id);
    if (!current) return null;
    this.db.prepare("UPDATE measurement_definitions SET enabled = 0 WHERE id = ?").run(id);
    return { ...current, enabled: false };
  }

  private insertMeasurementSample(sample: MeasurementSample, deduplicateAcrossSources = false): boolean {
    if (deduplicateAcrossSources && this.db.prepare(`SELECT 1 FROM measurement_samples
      WHERE sensor_id = ? AND metric = ? AND timestamp = ? LIMIT 1`)
      .get(sample.sensorId, sample.metric, sample.timestamp)) return false;
    const result = this.db.prepare(`INSERT OR IGNORE INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sample.sensorId, sample.metric, sample.value, sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);
    return Number(result.changes) > 0;
  }

  insertMeasurementSamples(samples: MeasurementSample[], options: { deduplicateAcrossSources?: boolean } = {}): MeasurementSample[] {
    this.prepareTelemetrySources(samples.map((sample) => sample.source));
    return this.immediateTransaction(() => {
      const inserted: MeasurementSample[] = [];
      for (const sample of samples) {
        if (this.insertMeasurementSample(sample, options.deduplicateAcrossSources)) inserted.push(sample);
      }
      return inserted;
    });
  }

  latestMeasurementSamples(houseId?: string): MeasurementSample[] {
    const where = houseId ? "WHERE s.house_id = ?" : "";
    const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
      SELECT ms.sensor_id, ms.metric, ms.value, ms.canonical_unit, ms.timestamp, ms.source, ms.quality,
        ROW_NUMBER() OVER (PARTITION BY ms.sensor_id, ms.metric ORDER BY ms.timestamp DESC, ms.id DESC) AS row_number
      FROM measurement_samples ms JOIN sensors s ON s.id = ms.sensor_id ${where}
    ) WHERE row_number = 1 ORDER BY sensor_id, metric`)
      .all(...(houseId ? [houseId] : [])) as unknown as MeasurementSampleRow[];
    return rows.map(measurementSampleFromRow);
  }

  getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null {
    const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE sensor_id = ? AND metric = ? ORDER BY timestamp DESC, id DESC LIMIT 1`)
      .get(sensorId, metric) as unknown as MeasurementSampleRow | undefined;
    return row ? measurementSampleFromRow(row) : null;
  }

  measurementHistory(sensorId: string, metric: string, from: string, to: string, limit = 20_000): MeasurementSample[] {
    const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
      SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC, id DESC LIMIT ?
    ) ORDER BY timestamp ASC, id ASC`).all(sensorId, metric, from, to, limit) as unknown as MeasurementSampleRow[];
    return rows.map(measurementSampleFromRow);
  }

  /**
   * Bounded, quality-weighted temperature buckets for synchronous thermal fitting.
   * Aggregation happens in SQLite so dense 2-10 second telemetry never enters the
   * Node calibration loop or consumes the raw-row limit before covering 7 days.
   */
  thermalTemperatureHistory(
    sensorId: string,
    from: string,
    to: string,
    bucketMinutes = 5,
    limit = 5_000,
  ): MeasurementSample[] {
    if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 60) {
      throw new ClimateDataValidationError(400, "INVALID_BUCKET_SIZE", "Thermal bucket size must be 1 to 60 minutes");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) {
      throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Thermal history limit must be 1 to 20000");
    }
    const bucketSeconds = bucketMinutes * 60;
    const rows = this.db.prepare(`WITH source_rows AS (
        SELECT
          CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch,
          value,
          canonical_unit,
          source,
          quality,
          CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END AS sample_weight
        FROM measurement_samples
        WHERE sensor_id = ? AND metric = 'temperature' AND timestamp >= ? AND timestamp <= ?
          AND quality <> 'stale' AND source <> 'replay'
      ), recent_buckets AS (
        SELECT
          bucket_epoch,
          SUM(value * sample_weight) / SUM(sample_weight) AS value,
          MAX(canonical_unit) AS canonical_unit,
          MIN(source) AS source,
          MAX(CASE WHEN quality = 'good' THEN 1 ELSE 0 END) AS has_good
        FROM source_rows
        WHERE bucket_epoch IS NOT NULL
        GROUP BY bucket_epoch
        ORDER BY bucket_epoch DESC
        LIMIT ?
      )
      SELECT bucket_epoch, value, canonical_unit, source, has_good
      FROM recent_buckets ORDER BY bucket_epoch ASC`)
      .all(bucketSeconds, bucketSeconds, sensorId, from, to, limit) as unknown as Array<{
        bucket_epoch: number;
        value: number;
        canonical_unit: string;
        source: MeasurementSample["source"];
        has_good: number;
      }>;
    return rows.map((row) => ({
      sensorId,
      metric: "temperature",
      value: row.value,
      canonicalUnit: row.canonical_unit,
      timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
      source: row.source,
      quality: row.has_good ? "good" : "estimated",
    }));
  }

  upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample {
    if (![sample.temperatureC, Date.parse(sample.timestamp), Date.parse(sample.fetchedAt)].every(Number.isFinite)) {
      throw new ClimateDataValidationError(400, "INVALID_OUTDOOR_SAMPLE", "Outdoor temperature and timestamps must be finite");
    }
    if (!this.getHouse(sample.houseId)) {
      throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
    }
    if (sample.source === "mock" && this.isRealDataMode()) {
      throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Synthetic outdoor samples are permanently disabled in real-data mode");
    }
    if (sample.source !== "mock" && !this.isRealDataMode()) this.activateRealDataMode();
    this.db.prepare(`INSERT INTO outdoor_temperature_samples
      (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(house_id, location_key, timestamp, source) DO UPDATE SET
        temperature_c = excluded.temperature_c,
        fetched_at = excluded.fetched_at,
        station_id = excluded.station_id,
        station_name = excluded.station_name`)
      .run(sample.houseId, sample.locationKey, sample.timestamp, sample.temperatureC, sample.source,
        sample.fetchedAt, sample.stationId, sample.stationName);
    return sample;
  }

  /**
   * Persist a live boundary only while its opaque location key still matches
   * the house's current weather location. The check happens before the
   * irreversible real-data latch in `upsertOutdoorTemperatureSample`.
   */
  upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample {
    const house = this.getHouse(sample.houseId);
    if (!house) {
      throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
    }
    if (sample.locationKey !== outdoorLocationKey(house.location)) {
      throw new ClimateDataValidationError(
        409,
        "WEATHER_REQUEST_SUPERSEDED",
        "House location changed while weather was loading; the old-location observation was discarded",
      );
    }
    return this.upsertOutdoorTemperatureSample(sample);
  }

  outdoorTemperatureHistory(
    houseId: string,
    locationKey: string,
    from: string,
    to: string,
    limit = 20_000,
  ): OutdoorTemperatureSample[] {
    const rows = this.db.prepare(`SELECT house_id, location_key, timestamp, temperature_c, source, fetched_at,
      station_id, station_name FROM (
        SELECT rowid, house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name
        FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC, rowid DESC LIMIT ?
      ) ORDER BY timestamp ASC, rowid ASC`)
      .all(houseId, locationKey, from, to, limit) as unknown as OutdoorTemperatureRow[];
    return rows.map(outdoorTemperatureFromRow);
  }

  private insertReading(reading: Reading): boolean {
    const inserted = this.insertLegacyReadingUnchecked(reading);
    if (inserted) {
      const values: Record<string, number> = {
        ...(reading.measurements ?? {}),
        temperature: reading.temperature,
        humidity: reading.humidity,
      };
      for (const [metric, value] of Object.entries(values)) {
        const definition = this.getMeasurementDefinition(metric);
        if (!definition) continue;
        this.insertMeasurementSample({
          sensorId: reading.sensorId,
          metric,
          value,
          canonicalUnit: definition.unit,
          timestamp: reading.timestamp,
          source: reading.source,
          quality: reading.quality,
        });
      }
    }
    return inserted;
  }

  insertLegacyReading(reading: Reading): boolean {
    this.prepareTelemetrySources([reading.source]);
    return this.insertLegacyReadingUnchecked(reading);
  }

  private insertLegacyReadingUnchecked(reading: Reading): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
    return Number(result.changes) > 0;
  }

  insertReadings(readings: Reading[]): Reading[] {
    this.prepareTelemetrySources(readings.map((reading) => reading.source));
    const inserted: Reading[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const reading of readings) {
        if (this.insertReading(reading)) inserted.push(reading);
      }
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  latestReadings(sensorIds?: string[]): Reading[] {
    const filter = sensorIds?.length ? `WHERE sensor_id IN (${sensorIds.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
      FROM (
        SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality,
          ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY timestamp DESC, id DESC) AS row_number
        FROM readings ${filter}
      ) WHERE row_number = 1 ORDER BY sensor_id`)
      .all(...(sensorIds ?? [])) as unknown as ReadingRow[];
    return rows.map(readingFromRow);
  }

  getLatestReading(sensorId: string): Reading | null {
    const row = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
      FROM readings WHERE sensor_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId) as unknown as ReadingRow | undefined;
    return row ? readingFromRow(row) : null;
  }

  history(sensorIds: string[], from: string, to: string, limit = 20_000): Reading[] {
    if (sensorIds.length === 0) return [];
    const placeholders = sensorIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
      FROM (
        SELECT id, sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM readings WHERE sensor_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, id ASC`).all(...sensorIds, from, to, limit) as unknown as ReadingRow[];
    return rows.map(readingFromRow);
  }

  purgeReadingsBefore(timestamp: string, batchSize = 5_000): number {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50_000) {
      throw new ClimateDataValidationError(400, "INVALID_BATCH_SIZE", "Retention batch size must be an integer from 1 to 50000");
    }
    const deleteBatches = (table: "measurement_samples" | "readings"): number => {
      const statement = this.db.prepare(`DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE timestamp < ? ORDER BY timestamp, id LIMIT ?
      )`);
      let deleted = 0;
      while (true) {
        const changes = Number(statement.run(timestamp, batchSize).changes);
        deleted += changes;
        if (changes < batchSize) return deleted;
      }
    };
    const outdoorStatement = this.db.prepare(`DELETE FROM outdoor_temperature_samples WHERE rowid IN (
      SELECT rowid FROM outdoor_temperature_samples WHERE timestamp < ? ORDER BY timestamp, rowid LIMIT ?
    )`);
    let outdoorDeleted = 0;
    while (true) {
      const changes = Number(outdoorStatement.run(timestamp, batchSize).changes);
      outdoorDeleted += changes;
      if (changes < batchSize) break;
    }
    return deleteBatches("measurement_samples") + deleteBatches("readings") + outdoorDeleted;
  }

  listAlertRules(): AlertRule[] {
    return (this.db.prepare("SELECT * FROM alert_rules ORDER BY name").all() as unknown as AlertRuleRow[]).map(ruleFromRow);
  }

  getAlertRule(id: string): AlertRule | null {
    const row = this.db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(id) as unknown as AlertRuleRow | undefined;
    return row ? ruleFromRow(row) : null;
  }

  saveAlertRule(input: Omit<AlertRule, "id"> & { id?: string }): AlertRule {
    const rule: AlertRule = { ...input, id: input.id ?? randomUUID() };
    this.db.prepare(`INSERT INTO alert_rules
      (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rule.id, rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds,
        rule.severity, rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0);
    return rule;
  }

  updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null {
    const current = this.getAlertRule(id);
    if (!current) return null;
    const rule: AlertRule = { ...current, ...patch, id };
    this.db.prepare(`UPDATE alert_rules SET name = ?, sensor_id = ?, metric = ?, operator = ?, threshold = ?,
      duration_seconds = ?, severity = ?, enabled = ?, webhook_enabled = ? WHERE id = ?`)
      .run(rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds, rule.severity,
        rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, id);
    return rule;
  }

  deleteAlertRule(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id).changes) > 0;
  }

  createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent {
    const event: AlertEvent = { ...input, id: randomUUID(), acknowledgedAt: null, resolvedAt: null };
    this.db.prepare(`INSERT INTO alert_events
      (id, rule_id, sensor_id, metric, value, threshold, severity, started_at, acknowledged_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.ruleId, event.sensorId, event.metric, event.value, event.threshold, event.severity,
        event.startedAt, null, null);
    return event;
  }

  listAlertEvents(limit = 200, activeOnly = false): AlertEvent[] {
    const rows = this.db.prepare(`SELECT * FROM alert_events ${activeOnly ? "WHERE resolved_at IS NULL" : ""}
      ORDER BY started_at DESC LIMIT ?`).all(limit) as unknown as AlertEventRow[];
    return rows.map(eventFromRow);
  }

  activeAlert(ruleId: string, sensorId: string): AlertEvent | null {
    const row = this.db.prepare(`SELECT * FROM alert_events
      WHERE rule_id = ? AND sensor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .get(ruleId, sensorId) as unknown as AlertEventRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  acknowledgeAlert(id: string, timestamp: string): AlertEvent | null {
    this.db.prepare("UPDATE alert_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?").run(timestamp, id);
    return this.getAlertEvent(id);
  }

  resolveAlert(id: string, timestamp: string): AlertEvent | null {
    this.db.prepare("UPDATE alert_events SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?").run(timestamp, id);
    return this.getAlertEvent(id);
  }

  getAlertEvent(id: string): AlertEvent | null {
    const row = this.db.prepare("SELECT * FROM alert_events WHERE id = ?").get(id) as unknown as AlertEventRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  listObservations(houseId?: string): ManualObservation[] {
    const rows = (houseId
      ? this.db.prepare("SELECT * FROM observations WHERE house_id = ? ORDER BY occurred_at DESC").all(houseId)
      : this.db.prepare("SELECT * FROM observations ORDER BY occurred_at DESC").all()) as unknown as ObservationRow[];
    return rows.map(observationFromRow);
  }

  createObservation(input: Omit<ManualObservation, "id" | "createdAt"> & { id?: string }): ManualObservation {
    const observation: ManualObservation = { ...input, id: input.id ?? randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO observations
      (id, house_id, floor_id, sensor_id, kind, severity, note, x, y, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(observation.id, observation.houseId, observation.floorId, observation.sensorId, observation.kind,
        observation.severity, observation.note, observation.x, observation.y, observation.occurredAt, observation.createdAt);
    return observation;
  }

  deleteObservation(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM observations WHERE id = ?").run(id).changes) > 0;
  }

  listParameters(houseId?: string): StaticParameter[] {
    const rows = (houseId
      ? this.db.prepare("SELECT * FROM static_parameters WHERE house_id = ? ORDER BY label").all(houseId)
      : this.db.prepare("SELECT * FROM static_parameters ORDER BY label").all()) as unknown as StaticParameterRow[];
    return rows.map(parameterFromRow);
  }

  saveParameter(input: Omit<StaticParameter, "id"> & { id?: string }): StaticParameter {
    const parameter: StaticParameter = { ...input, id: input.id ?? randomUUID() };
    this.db.prepare(`INSERT INTO static_parameters
      (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(house_id, scope_type, scope_id, key) DO UPDATE SET
        value_json = excluded.value_json, unit = excluded.unit, label = excluded.label`)
      .run(parameter.id, parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key,
        JSON.stringify(parameter.value), parameter.unit, parameter.label);
    const row = this.db.prepare(`SELECT * FROM static_parameters
      WHERE house_id = ? AND scope_type = ? AND scope_id = ? AND key = ?`)
      .get(parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key) as unknown as StaticParameterRow;
    return parameterFromRow(row);
  }

  deleteParameter(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM static_parameters WHERE id = ?").run(id).changes) > 0;
  }

  createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & { data: Uint8Array }): AssetRecord {
    const asset: AssetRecord = {
      id: randomUUID(), houseId: input.houseId, name: input.name, mimeType: input.mimeType, kind: input.kind,
      size: input.data.byteLength, createdAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(asset.id, asset.houseId, asset.name, asset.mimeType, asset.kind, input.data, asset.size, asset.createdAt);
    return asset;
  }

  listAssets(houseId?: string): AssetRecord[] {
    const sql = `SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size, created_at as createdAt
      FROM assets ${houseId ? "WHERE house_id = ?" : ""} ORDER BY created_at DESC`;
    return (houseId ? this.db.prepare(sql).all(houseId) : this.db.prepare(sql).all()) as unknown as AssetRecord[];
  }

  getAsset(id: string): (AssetRecord & { data: Uint8Array }) | null {
    const row = this.db.prepare(`SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size,
      created_at as createdAt, data FROM assets WHERE id = ?`).get(id);
    return row as unknown as (AssetRecord & { data: Uint8Array }) | null;
  }

  deleteAsset(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM assets WHERE id = ?").run(id).changes) > 0;
  }
}
