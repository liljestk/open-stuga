import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AlertEvent,
  AlertRule,
  Floor,
  House,
  HouseLocation,
  ManualObservation,
  MeasurementDefinition,
  MeasurementSample,
  Reading,
  Sensor,
  StaticParameter,
} from "@climate-twin/contracts";

type JsonValue = string | number | boolean;

interface HouseRow {
  id: string;
  name: string;
  timezone: string;
  location_json: string | null;
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

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function houseFromRow(row: HouseRow): House {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    ...(row.location_json ? { location: parseJson<HouseLocation>(row.location_json) } : {}),
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

export class ClimateDatabase {
  readonly db: DatabaseSync;

  constructor(path: string, seed = true) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    if (seed) this.seed();
    this.backfillLegacyMeasurements();
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
    `);
    const houseColumns = this.db.prepare("PRAGMA table_info(houses)").all() as unknown as Array<{ name: string }>;
    if (!houseColumns.some((column) => column.name === "location_json")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN location_json TEXT");
    }
    const sensorColumns = this.db.prepare("PRAGMA table_info(sensors)").all() as unknown as Array<{ name: string }>;
    if (!sensorColumns.some((column) => column.name === "measurement_entity_ids_json")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN measurement_entity_ids_json TEXT");
    }
    const insertDefinition = this.db.prepare(`INSERT OR IGNORE INTO measurement_definitions
      (id, labels_json, unit, precision, valid_min, valid_max, display_min, display_max, interpolation_delta,
       color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`);
    insertDefinition.run("temperature", JSON.stringify({ en: "Temperature", fi: "Lämpötila" }), "°C", 1, -80, 100, 15, 30, 2, "thermal");
    insertDefinition.run("humidity", JSON.stringify({ en: "Humidity", fi: "Ilmankosteus" }), "%", 0, 0, 100, 20, 80, 10, "humidity");
    insertDefinition.run("co2", JSON.stringify({ en: "Carbon dioxide", fi: "Hiilidioksidi" }), "ppm", 0, 0, 10_000, 400, 2_000, 250, "air-quality");
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
        width: 14,
        height: 10,
        elevation: 0,
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
        width: 14,
        height: 10,
        elevation: 3,
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
        (id, name, timezone, location_json, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("house-main", "My climate twin", "Europe/Helsinki", null, JSON.stringify(floors), now, now);
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

  createHouse(input: Pick<House, "name" | "timezone" | "floors"> & { id?: string; location?: HouseLocation }): House {
    this.validateFloorDefinitions(input.floors);
    if (input.location) this.validateHouseLocation(input.location);
    const timestamp = new Date().toISOString();
    const house: House = {
      id: input.id ?? randomUUID(), name: input.name, timezone: input.timezone,
      ...(input.location ? { location: input.location } : {}), floors: input.floors,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO houses
      (id, name, timezone, location_json, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(house.id, house.name, house.timezone, house.location ? JSON.stringify(house.location) : null,
        JSON.stringify(house.floors), house.createdAt, house.updatedAt);
    return house;
  }

  updateHouse(
    id: string,
    patch: Partial<Pick<House, "name" | "timezone" | "floors">> & { location?: HouseLocation | null },
  ): House | null {
    return this.immediateTransaction(() => {
      const current = this.getHouse(id);
      if (!current) return null;
      // Apply optional fields explicitly so a nullable location patch never leaks
      // `null` into the public House contract (absence is represented by omission).
      const next: House = { ...current, id, updatedAt: new Date().toISOString() };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.timezone !== undefined) next.timezone = patch.timezone;
      if (patch.floors !== undefined) next.floors = patch.floors;
      if (patch.location === null) delete next.location;
      else if (patch.location !== undefined) next.location = patch.location;
      if (next.location) this.validateHouseLocation(next.location);
      this.validateFloorDefinitions(next.floors);
      this.validateHouseLayoutForSensors(id, next.floors);
      this.db.prepare("UPDATE houses SET name = ?, timezone = ?, location_json = ?, floors_json = ?, updated_at = ? WHERE id = ?")
        .run(next.name, next.timezone, next.location ? JSON.stringify(next.location) : null,
          JSON.stringify(next.floors), next.updatedAt, id);
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
      this.writeSensor(sensor, true);
      return sensor;
    });
  }

  updateSensor(id: string, patch: Partial<Omit<Sensor, "id">>): Sensor | null {
    return this.immediateTransaction(() => {
      const current = this.getSensor(id);
      if (!current) return null;
      const sensor: Sensor = { ...current, ...patch, id };
      this.validateSensorPlacement(sensor);
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
      null,
      JSON.stringify(sensor.tags), sensor.enabled ? 1 : 0, sensor.id];
    if (insert) {
      this.db.prepare(`INSERT INTO sensors
        (house_id, floor_id, name, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id,
         measurement_entity_ids_json, tags_json, enabled, id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values);
    } else {
      this.db.prepare(`UPDATE sensors SET house_id = ?, floor_id = ?, name = ?, room = ?, model = ?, x = ?, y = ?, z = ?,
        temperature_entity_id = ?, humidity_entity_id = ?, battery_entity_id = ?, measurement_entity_ids_json = ?,
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

  private insertMeasurementSample(sample: MeasurementSample): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sample.sensorId, sample.metric, sample.value, sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);
    return Number(result.changes) > 0;
  }

  insertMeasurementSamples(samples: MeasurementSample[]): MeasurementSample[] {
    return this.immediateTransaction(() => {
      const inserted: MeasurementSample[] = [];
      for (const sample of samples) if (this.insertMeasurementSample(sample)) inserted.push(sample);
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

  insertReading(reading: Reading): boolean {
    const inserted = this.insertLegacyReading(reading);
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
    const result = this.db.prepare(`INSERT OR IGNORE INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
    return Number(result.changes) > 0;
  }

  insertReadings(readings: Reading[]): Reading[] {
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
    return deleteBatches("measurement_samples") + deleteBatches("readings");
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
