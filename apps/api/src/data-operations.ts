import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  BackupOperationStatus,
  DataExportPreview,
  DataExportPrivacyLevel,
} from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";

const EXPORT_TABLES = [
  "properties", "houses", "property_areas", "area_equipment", "property_notes", "sensors",
  "measurement_definitions", "alert_rules", "alert_events", "observations", "maintenance_tasks",
  "action_playbooks", "action_runs", "property_electricity_configs", "electricity_price_points",
  "measurement_samples", "readings", "outdoor_temperature_samples",
] as const;

interface BackupWorkerState extends BackupOperationStatus {
  version: 1;
}

function safeJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function tableCount(database: ClimateDatabase, table: string): number {
  try {
    return Number((database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  } catch {
    return 0;
  }
}

function latestManifestAt(directory: string | undefined): string | null {
  if (!directory || !existsSync(directory)) return null;
  let latest: string | null = null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(directory, entry.name, "manifest.json");
    const manifest = safeJsonFile<{ createdAt?: unknown }>(manifestPath);
    if (typeof manifest?.createdAt === "string" && Number.isFinite(Date.parse(manifest.createdAt))
      && (!latest || Date.parse(manifest.createdAt) > Date.parse(latest))) latest = manifest.createdAt;
  }
  return latest;
}

export class DataOperationsService {
  readonly #operationsDirectory: string;
  readonly #backupDirectory: string | undefined;

  constructor(private readonly database: ClimateDatabase, config: AppConfig) {
    this.#operationsDirectory = config.backupOperationsDirectory ?? "";
    this.#backupDirectory = config.backupDirectory;
  }

  preview(privacyLevel: DataExportPrivacyLevel, includesTelemetry: boolean): DataExportPreview {
    const counts: Record<string, number> = {};
    for (const table of EXPORT_TABLES) {
      if (!includesTelemetry && ["measurement_samples", "readings", "outdoor_temperature_samples", "electricity_price_points"].includes(table)) continue;
      if (privacyLevel === "structure" && ["property_notes", "alert_events", "observations", "maintenance_tasks", "action_runs"].includes(table)) continue;
      counts[table] = tableCount(this.database, table);
    }
    const estimatedTelemetryRows = ["measurement_samples", "readings", "outdoor_temperature_samples", "electricity_price_points"]
      .reduce((total, table) => total + tableCount(this.database, table), 0);
    const sensitiveCategories = ["property and building layout", "sensor names and placement"];
    if (privacyLevel !== "structure") sensitiveCategories.push("maintenance, observations, and alert history");
    if (includesTelemetry) sensitiveCategories.push("timestamped environmental and energy telemetry");
    return {
      schemaVersion: "stuga.export/v1",
      generatedAt: new Date().toISOString(),
      privacyLevel,
      includesTelemetry,
      counts,
      sensitiveCategories,
      estimatedTelemetryRows,
    };
  }

  /** Builds the bounded control-plane part; raw telemetry is streamed separately by the route. */
  bundle(privacyLevel: DataExportPrivacyLevel): Record<string, unknown> {
    const properties = this.database.listProperties(500, 0);
    const houses = this.database.listHouses();
    const structure = {
      properties,
      houses,
      areas: properties.flatMap((property) => this.database.listPropertyAreas(property.id, 500, 0)),
      equipment: properties.flatMap((property) => this.database.listAreaEquipment({ propertyId: property.id, limit: 500 })),
      sensors: this.database.listSensors(),
      measurementDefinitions: this.database.listMeasurementDefinitions(),
      electricityConfiguration: properties.map((property) => this.database.getPropertyElectricityConfig(property.id)).filter(Boolean),
      staticParameters: houses.flatMap((house) => this.database.listParameters(house.id)),
    };
    if (privacyLevel === "structure") return structure;
    return {
      ...structure,
      notes: properties.flatMap((property) => this.database.listPropertyNotes({ propertyId: property.id, limit: 500 })),
      alertRules: this.database.listAlertRules(),
      alertEvents: this.database.listAlertEvents(500, false, 0),
      observations: this.database.listObservations(),
      maintenanceTasks: properties.flatMap((property) => this.database.listMaintenanceTasks({ propertyId: property.id, limit: 500 })),
      actionPlaybooks: this.database.listActionPlaybooks(),
      actionRuns: this.database.listActionRuns(),
    };
  }

  audit(eventType: string, detail: Record<string, unknown>): void {
    this.database.db.prepare(`INSERT INTO data_audit_events(id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), eventType, JSON.stringify(detail), new Date().toISOString());
  }

  backupStatus(): BackupOperationStatus {
    const statePath = this.#operationsDirectory ? join(this.#operationsDirectory, "status.json") : "";
    const state = statePath ? safeJsonFile<BackupWorkerState>(statePath) : null;
    const latest = state?.latestVerifiedBackupAt ?? latestManifestAt(this.#backupDirectory);
    return {
      available: Boolean(this.#operationsDirectory),
      schedulerHealthy: Boolean(state?.schedulerHealthy),
      requestId: state?.requestId ?? null,
      state: state?.state ?? "idle",
      requestedAt: state?.requestedAt ?? null,
      completedAt: state?.completedAt ?? null,
      backupPath: state?.backupPath ?? null,
      lastError: state?.lastError ?? null,
      latestVerifiedBackupAt: latest,
      latestRestoreDrillAt: state?.latestRestoreDrillAt ?? null,
    };
  }

  requestBackup(): BackupOperationStatus {
    if (!this.#operationsDirectory) throw new Error("The isolated backup worker is not configured");
    mkdirSync(this.#operationsDirectory, { recursive: true, mode: 0o700 });
    const current = this.backupStatus();
    if (current.state === "requested" || current.state === "running") return current;
    const requestedAt = new Date().toISOString();
    const requestId = randomUUID();
    const requestPath = join(this.#operationsDirectory, `${requestId}.request.json`);
    atomicJson(requestPath, { version: 1, requestId, requestedAt, operation: "backup-and-verify" });
    const state: BackupWorkerState = {
      version: 1,
      available: true,
      schedulerHealthy: current.schedulerHealthy,
      requestId,
      state: "requested",
      requestedAt,
      completedAt: null,
      backupPath: null,
      lastError: null,
      latestVerifiedBackupAt: current.latestVerifiedBackupAt,
      latestRestoreDrillAt: current.latestRestoreDrillAt,
    };
    atomicJson(join(this.#operationsDirectory, "status.json"), state);
    this.audit("backup.requested", { requestId });
    return state;
  }

  operationsDirectoryHealthy(): boolean {
    if (!this.#operationsDirectory || !existsSync(this.#operationsDirectory)) return false;
    try { return statSync(this.#operationsDirectory).isDirectory(); } catch { return false; }
  }
}
