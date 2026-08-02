import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AnalyticsAggregation,
  AnalyticsQueryResponse,
  AnalyticsResolution,
  MeasurementDefinition,
  ScheduledDataExport,
  ScheduledDataExportFrequency,
  ScheduledDataExportInput,
  ScheduledDataExportPeriod,
  ScheduledDataExportUpdate,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";
import type { DataOperationsService } from "./data-operations.js";
import { executeAnalyticsQuery } from "./analytics/query/execute.js";
import type { HybridTelemetryReader } from "./timeseries/read-facade.js";
import type { SystemStorageService } from "./system-storage.js";

const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_SOURCE_POINTS = 250_000;
const EXPORT_POLL_MS = 30_000;
const PENDING_RUN_TIMEOUT_MS = 2 * 3_600_000;
const FREQUENCIES: ScheduledDataExportFrequency[] = ["daily", "weekly", "monthly"];
const PERIODS: ScheduledDataExportPeriod[] = ["24h", "7d", "30d", "90d"];
const AGGREGATIONS: AnalyticsAggregation[] = [
  "default", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max",
];

interface ScheduledExportRow {
  id: string;
  house_id: string;
  name: string;
  enabled: number;
  frequency: string;
  time_local: string;
  day_of_week: number | null;
  day_of_month: number | null;
  period: string;
  sensor_ids_json: string;
  measurement_ids_json: string;
  resolution: string;
  aggregation: string;
  retention_count: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string;
  last_run_error: string | null;
  last_output_name: string | null;
  pending_run_id: string | null;
  pending_started_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ScheduledDataExportServiceOptions {
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  systemStorage: Pick<SystemStorageService, "status">;
  dataOperations: Pick<DataOperationsService, "audit">;
  operationsDirectory?: string | null;
  now?: () => Date;
}

interface ZonedParts {
  year: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  second: number;
}

export class ScheduledDataExportError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ScheduledDataExportError";
  }
}

function stringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function publicSchedule(row: ScheduledExportRow): ScheduledDataExport {
  return {
    id: row.id,
    houseId: row.house_id,
    name: row.name,
    enabled: row.enabled === 1,
    frequency: row.frequency as ScheduledDataExportFrequency,
    timeLocal: row.time_local,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    period: row.period as ScheduledDataExportPeriod,
    sensorIds: stringArray(row.sensor_ids_json),
    measurementIds: stringArray(row.measurement_ids_json),
    resolution: row.resolution as Exclude<AnalyticsResolution, "auto">,
    aggregation: row.aggregation as AnalyticsAggregation,
    retentionCount: row.retention_count,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status as ScheduledDataExport["lastRunStatus"],
    lastRunError: row.last_run_error,
    lastOutputName: row.last_output_name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zonedParts(timestamp: number, dateFormatter: Intl.DateTimeFormat): ZonedParts {
  const parts = dateFormatter.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? NaN);
  return {
    year: part("year"),
    month: part("month"),
    date: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

function matchingInstants(parts: Omit<ZonedParts, "second">, dateFormatter: Intl.DateTimeFormat): number[] {
  const wallTime = Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour, parts.minute);
  const offsets = new Set<number>();
  for (const delta of [-36 * 3_600_000, 0, 36 * 3_600_000]) {
    const probe = wallTime + delta;
    const local = zonedParts(probe, dateFormatter);
    offsets.add(Date.UTC(local.year, local.month - 1, local.date, local.hour, local.minute, local.second) - probe);
  }
  return [...offsets].map((offset) => wallTime - offset).filter((candidate) => {
    const local = zonedParts(candidate, dateFormatter);
    return local.year === parts.year && local.month === parts.month && local.date === parts.date
      && local.hour === parts.hour && local.minute === parts.minute;
  }).filter((value, index, values) => values.indexOf(value) === index).sort((left, right) => left - right);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextScheduledDataExportRun(
  schedule: Pick<ScheduledDataExportInput, "frequency" | "timeLocal" | "dayOfWeek" | "dayOfMonth">,
  timeZone: string,
  after: Date,
): string {
  const [hour, minute] = schedule.timeLocal.split(":").map(Number);
  const dateFormatter = formatter(timeZone);
  const local = zonedParts(after.getTime(), dateFormatter);
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.date + offset));
    if (schedule.frequency === "weekly" && day.getUTCDay() !== schedule.dayOfWeek) continue;
    if (schedule.frequency === "monthly") {
      const expected = Math.min(schedule.dayOfMonth ?? 1, lastDayOfMonth(day.getUTCFullYear(), day.getUTCMonth() + 1));
      if (day.getUTCDate() !== expected) continue;
    }
    const candidate = matchingInstants({
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      date: day.getUTCDate(),
      hour: hour!,
      minute: minute!,
    }, dateFormatter)[0];
    if (candidate !== undefined && candidate > after.getTime()) return new Date(candidate).toISOString();
  }
  throw new Error("The next scheduled export time could not be resolved");
}

function allowedAggregations(definition: MeasurementDefinition): ReadonlySet<AnalyticsAggregation> {
  switch (definition.kind ?? "gauge") {
    case "rate": return new Set(["default", "mean", "time_weighted_mean", "min", "max", "last"]);
    case "increment": return new Set(["default", "sum", "min", "max", "last"]);
    case "cumulative_counter": return new Set(["default", "delta", "min", "max", "last"]);
    case "binary_state": return new Set(["default", "mean", "last"]);
    case "categorical_state": return new Set(["default", "last"]);
    default: return new Set(["default", "mean", "min", "max", "last"]);
  }
}

function resolutionMilliseconds(resolution: string): number | null {
  if (resolution === "raw") return null;
  if (resolution === "1h") return 3_600_000;
  if (resolution === "1d") return 86_400_000;
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 1_440 ? minutes * 60_000 : null;
}

function periodMilliseconds(period: ScheduledDataExportPeriod): number {
  if (period === "24h") return 86_400_000;
  if (period === "7d") return 7 * 86_400_000;
  if (period === "30d") return 30 * 86_400_000;
  return 90 * 86_400_000;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  const safe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function localTimestamp(value: string, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function scheduledDataExportCsv(
  response: AnalyticsQueryResponse,
  definitions: readonly MeasurementDefinition[],
  timeZone: string,
): string {
  const definitionMap = new Map(definitions.map((definition) => [definition.id, definition]));
  const columns = definitions.map((definition) => ({
    id: definition.id,
    label: definition.labels.en ?? Object.values(definition.labels)[0] ?? definition.id,
    unit: definition.unit,
    precision: definition.precision,
  }));
  const rows = new Map<string, { timestamp: string; sensorId: string; sensorName: string; values: Record<string, number | null> }>();
  for (const series of response.series) {
    for (const point of series.points) {
      const key = JSON.stringify([series.entityId, point.timestamp]);
      const row = rows.get(key) ?? {
        timestamp: point.timestamp,
        sensorId: series.entityId,
        sensorName: series.entityLabel,
        values: {},
      };
      const precision = definitionMap.get(series.measurementId)?.precision ?? 3;
      const factor = 10 ** Math.min(6, Math.max(0, precision));
      row.values[series.measurementId] = point.value === null ? null : Math.round((point.value + Number.EPSILON) * factor) / factor;
      rows.set(key, row);
    }
  }
  const output: Array<Array<string | number | null>> = [[
    "Home time", "UTC timestamp", "Sensor name", "Sensor ID",
    ...columns.map((column) => `${column.label}${column.unit ? ` (${column.unit})` : ""}`),
  ]];
  for (const row of [...rows.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || left.sensorName.localeCompare(right.sensorName) || left.sensorId.localeCompare(right.sensorId))) {
    output.push([
      localTimestamp(row.timestamp, timeZone), row.timestamp, row.sensorName, row.sensorId,
      ...columns.map((column) => row.values[column.id] ?? null),
    ]);
  }
  return `\uFEFF${output.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase().slice(0, 50) || "home";
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function durableFile(path: string, content: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

export class ScheduledDataExportService {
  readonly #database: ClimateDatabase;
  readonly #telemetryReader: HybridTelemetryReader;
  readonly #systemStorage: Pick<SystemStorageService, "status">;
  readonly #dataOperations: Pick<DataOperationsService, "audit">;
  readonly #operationsDirectory: string | null;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | null = null;
  #tickRunning = false;

  constructor(options: ScheduledDataExportServiceOptions) {
    this.#database = options.database;
    this.#telemetryReader = options.telemetryReader;
    this.#systemStorage = options.systemStorage;
    this.#dataOperations = options.dataOperations;
    this.#operationsDirectory = options.operationsDirectory ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#migrate();
    if (this.#operationsDirectory) mkdirSync(this.#operationsDirectory, { recursive: true, mode: 0o700 });
  }

  start(): void {
    if (this.#timer) return;
    this.#tickSafely();
    this.#timer = setInterval(() => this.#tickSafely(), EXPORT_POLL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  targetConfigured(): boolean {
    return this.#systemStorage.status().settings.backups.kind === "nas-path";
  }

  list(houseId: string): ScheduledDataExport[] {
    this.reconcileReceipts();
    return (this.#database.db.prepare(`SELECT * FROM scheduled_data_exports
      WHERE house_id = ? ORDER BY created_at, id`).all(houseId) as unknown as ScheduledExportRow[]).map(publicSchedule);
  }

  get(id: string): ScheduledDataExport | null {
    const row = this.#row(id);
    return row ? publicSchedule(row) : null;
  }

  create(houseId: string, value: unknown): ScheduledDataExport {
    const now = this.#now();
    const input = this.#validatedInput(houseId, value);
    if (input.enabled) this.#assertNasConfigured();
    const id = randomUUID();
    const createdAt = now.toISOString();
    const house = this.#database.getHouse(houseId)!;
    const nextRunAt = input.enabled ? nextScheduledDataExportRun(input, house.timezone, now) : null;
    this.#database.db.prepare(`INSERT INTO scheduled_data_exports(
      id, house_id, name, enabled, frequency, time_local, day_of_week, day_of_month, period,
      sensor_ids_json, measurement_ids_json, resolution, aggregation, retention_count, next_run_at,
      last_run_at, last_run_status, last_run_error, last_output_name, pending_run_id, pending_started_at,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'never', NULL, NULL, NULL, NULL, 1, ?, ?)`)
      .run(id, houseId, input.name, input.enabled ? 1 : 0, input.frequency, input.timeLocal,
        input.dayOfWeek ?? null, input.dayOfMonth ?? null, input.period, JSON.stringify(input.sensorIds),
        JSON.stringify(input.measurementIds), input.resolution, input.aggregation, input.retentionCount,
        nextRunAt, createdAt, createdAt);
    this.#dataOperations.audit("scheduled-data-export.created", { id, houseId, frequency: input.frequency });
    return this.get(id)!;
  }

  update(id: string, value: unknown): ScheduledDataExport {
    const current = this.#row(id);
    if (!current) throw new ScheduledDataExportError(404, "SCHEDULED_EXPORT_NOT_FOUND", "Scheduled export was not found");
    if (current.pending_run_id) throw new ScheduledDataExportError(409, "SCHEDULED_EXPORT_RUNNING", "Wait for the current export to finish before editing it");
    const update = this.#validatedInput(current.house_id, value, true) as ScheduledDataExportUpdate;
    if (update.baseRevision !== current.revision) {
      throw new ScheduledDataExportError(409, "SCHEDULED_EXPORT_REVISION_CONFLICT", "Scheduled export changed; reload it before saving");
    }
    if (update.enabled) this.#assertNasConfigured();
    const now = this.#now();
    const house = this.#database.getHouse(current.house_id)!;
    const nextRunAt = update.enabled ? nextScheduledDataExportRun(update, house.timezone, now) : null;
    const result = this.#database.db.prepare(`UPDATE scheduled_data_exports SET
      name = ?, enabled = ?, frequency = ?, time_local = ?, day_of_week = ?, day_of_month = ?, period = ?,
      sensor_ids_json = ?, measurement_ids_json = ?, resolution = ?, aggregation = ?, retention_count = ?,
      next_run_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(update.name, update.enabled ? 1 : 0, update.frequency, update.timeLocal,
        update.dayOfWeek ?? null, update.dayOfMonth ?? null, update.period, JSON.stringify(update.sensorIds),
        JSON.stringify(update.measurementIds), update.resolution, update.aggregation, update.retentionCount,
        nextRunAt, now.toISOString(), id, update.baseRevision);
    if (Number(result.changes) !== 1) {
      throw new ScheduledDataExportError(409, "SCHEDULED_EXPORT_REVISION_CONFLICT", "Scheduled export changed; reload it before saving");
    }
    this.#dataOperations.audit("scheduled-data-export.updated", { id, houseId: current.house_id, enabled: update.enabled });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const current = this.#row(id);
    if (!current) return false;
    if (current.pending_run_id) throw new ScheduledDataExportError(409, "SCHEDULED_EXPORT_RUNNING", "Wait for the current export to finish before deleting it");
    const deleted = Number(this.#database.db.prepare("DELETE FROM scheduled_data_exports WHERE id = ?").run(id).changes) === 1;
    if (deleted) this.#dataOperations.audit("scheduled-data-export.deleted", { id, houseId: current.house_id });
    return deleted;
  }

  async runNow(id: string): Promise<ScheduledDataExport> {
    this.reconcileReceipts();
    await this.#stage(id, false, true);
    return this.get(id)!;
  }

  async tick(): Promise<void> {
    if (this.#tickRunning) return;
    this.#tickRunning = true;
    try {
      this.reconcileReceipts();
      this.#failStaleRuns();
      const due = this.#database.db.prepare(`SELECT id FROM scheduled_data_exports
        WHERE enabled = 1 AND pending_run_id IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at LIMIT 3`).all(this.#now().toISOString()) as unknown as Array<{ id: string }>;
      for (const item of due) await this.#stage(item.id, true, false);
    } finally {
      this.#tickRunning = false;
    }
  }

  reconcileReceipts(): void {
    if (!this.#operationsDirectory || !existsSync(this.#operationsDirectory)) return;
    for (const name of readdirSync(this.#operationsDirectory).filter((candidate) => /^data-export-[0-9a-f-]{36}\.receipt\.json$/iu.test(candidate))) {
      const path = join(this.#operationsDirectory, name);
      let receipt: Record<string, unknown> | null = null;
      try {
        if (statSync(path).size <= MAX_RECEIPT_BYTES) receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        receipt = null;
      }
      const runId = typeof receipt?.runId === "string" ? receipt.runId : "";
      const expectedRunId = /^data-export-([0-9a-f-]{36})\.receipt\.json$/iu.exec(name)?.[1] ?? "";
      const scheduleId = typeof receipt?.scheduleId === "string" ? receipt.scheduleId : "";
      const status = receipt?.status === "complete" ? "complete" : receipt?.status === "failed" ? "failed" : null;
      if (receipt?.schema !== "stugu-data-export-receipt/v1" || !status || runId.toLowerCase() !== expectedRunId.toLowerCase()) {
        rmSync(path, { force: true });
        continue;
      }
      const pending = this.#database.db.prepare("SELECT id FROM scheduled_data_exports WHERE pending_run_id = ?")
        .get(runId) as { id: string } | undefined;
      if (!pending || (scheduleId && scheduleId !== pending.id)) {
        rmSync(path, { force: true });
        continue;
      }
      const outputName = status === "complete" && typeof receipt.outputName === "string" && receipt.outputName.endsWith(".csv")
        ? receipt.outputName.slice(0, 240) : null;
      if (status === "complete" && !outputName) {
        rmSync(path, { force: true });
        continue;
      }
      const error = status === "failed" && typeof receipt.error === "string" ? receipt.error.slice(0, 2_000) : null;
      const completedAt = typeof receipt.completedAt === "string" && Number.isFinite(Date.parse(receipt.completedAt))
        ? new Date(receipt.completedAt).toISOString() : this.#now().toISOString();
      const changed = this.#database.db.prepare(`UPDATE scheduled_data_exports SET
        last_run_status = ?, last_run_error = ?, last_output_name = ?, pending_run_id = NULL,
        pending_started_at = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ? AND pending_run_id = ?`).run(status, error, outputName, completedAt, pending.id, runId);
      if (Number(changed.changes) === 1) {
        this.#dataOperations.audit(`scheduled-data-export.${status}`, { id: pending.id, runId, outputName });
      }
      rmSync(path, { force: true });
    }
  }

  async #stage(id: string, advanceSchedule: boolean, throwOnFailure: boolean): Promise<void> {
    const row = this.#row(id);
    if (!row) {
      if (throwOnFailure) throw new ScheduledDataExportError(404, "SCHEDULED_EXPORT_NOT_FOUND", "Scheduled export was not found");
      return;
    }
    if (row.pending_run_id) {
      if (throwOnFailure) throw new ScheduledDataExportError(409, "SCHEDULED_EXPORT_RUNNING", "This export is already running");
      return;
    }
    if (advanceSchedule && row.enabled !== 1) return;
    try {
      this.#assertNasConfigured();
      if (!this.#operationsDirectory) throw new Error("The isolated export worker is not configured");
      const schedule = publicSchedule(row);
      const house = this.#database.getHouse(schedule.houseId);
      if (!house) throw new Error("The Home no longer exists");
      const started = this.#now();
      const runId = randomUUID();
      const nextRunAt = advanceSchedule ? nextScheduledDataExportRun(schedule, house.timezone, started) : schedule.nextRunAt;
      const claimed = this.#database.db.prepare(`UPDATE scheduled_data_exports SET
        pending_run_id = ?, pending_started_at = ?, last_run_at = ?, last_run_status = 'pending',
        last_run_error = NULL, next_run_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND pending_run_id IS NULL`).run(
          runId, started.toISOString(), started.toISOString(), nextRunAt, started.toISOString(), id,
        );
      if (Number(claimed.changes) !== 1) throw new ScheduledDataExportError(409, "SCHEDULED_EXPORT_RUNNING", "This export is already running");
      await this.#prepareHandoff(schedule, house.name, house.timezone, runId, started);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Scheduled export failed";
      const failedAt = this.#now();
      const house = this.#database.getHouse(row.house_id);
      const nextRunAt = advanceSchedule && row.enabled === 1 && house
        ? nextScheduledDataExportRun(publicSchedule(row), house.timezone, failedAt)
        : this.#row(id)?.next_run_at ?? row.next_run_at;
      this.#database.db.prepare(`UPDATE scheduled_data_exports SET last_run_status = 'failed', last_run_error = ?,
        pending_run_id = NULL, pending_started_at = NULL, next_run_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(message, nextRunAt, failedAt.toISOString(), id);
      this.#dataOperations.audit("scheduled-data-export.failed", { id, error: message });
      if (throwOnFailure) {
        if (error instanceof ScheduledDataExportError) throw error;
        throw new ScheduledDataExportError(503, "SCHEDULED_EXPORT_FAILED", message);
      }
    }
  }

  async #prepareHandoff(
    schedule: ScheduledDataExport,
    houseName: string,
    timeZone: string,
    runId: string,
    endedAt: Date,
  ): Promise<void> {
    const sensorsById = new Map(this.#database.listSensors(schedule.houseId).filter((sensor) => sensor.enabled)
      .map((sensor) => [sensor.id, sensor]));
    const sensors = schedule.sensorIds.map((sensorId) => sensorsById.get(sensorId)).filter((sensor) => sensor !== undefined);
    if (sensors.length !== schedule.sensorIds.length) throw new Error("One or more selected sensors are no longer available");
    const definitions = schedule.measurementIds.map((id) => this.#database.getMeasurementDefinition(id));
    if (definitions.some((definition) => !definition?.enabled)) throw new Error("One or more selected measurements are no longer available");
    const end = endedAt.toISOString();
    const start = new Date(endedAt.getTime() - periodMilliseconds(schedule.period)).toISOString();
    const response = await executeAnalyticsQuery({
      request: {
        apiVersion: "1.0",
        dataMode: this.#database.isRealDataMode() ? "live" : "demo",
        scope: { kind: "house", id: schedule.houseId, entityIds: schedule.sensorIds },
        measurementIds: schedule.measurementIds,
        range: { start, end, timezone: timeZone },
        resolution: schedule.resolution,
        aggregation: schedule.resolution === "raw" ? "default" : schedule.aggregation,
        qualityFilter: { include: ["good", "estimated"] },
        include: ["series", "summary", "quality", "provenance"],
        maxPointsPerSeries: 5_000,
        requestId: `scheduled-export-${runId}`,
      },
      sensors,
      definitions: definitions as MeasurementDefinition[],
      telemetryReader: this.#telemetryReader,
      generatedAt: endedAt.toISOString(),
      sourcePointLimit: MAX_EXPORT_SOURCE_POINTS,
    });
    const csv = scheduledDataExportCsv(response, definitions as MeasurementDefinition[], timeZone);
    if (Buffer.byteLength(csv, "utf8") > MAX_EXPORT_BYTES) {
      throw new Error("The scheduled export exceeds the 64 MiB NAS handoff limit");
    }
    const payloadName = `data-export-${runId}.csv`;
    const requestName = `data-export-${runId}.request.json`;
    const outputName = `stugu-${slug(houseName)}-${start.slice(0, 10)}-${end.slice(0, 10)}-${schedule.resolution}-${schedule.aggregation}-${runId.slice(0, 8)}.csv`;
    const payloadPath = join(this.#operationsDirectory!, payloadName);
    try {
      durableFile(payloadPath, csv);
      const bytes = Buffer.byteLength(csv, "utf8");
      atomicJson(join(this.#operationsDirectory!, requestName), {
        schema: "stugu-data-export-request/v1",
        runId,
        scheduleId: schedule.id,
        requestedAt: endedAt.toISOString(),
        payloadName,
        outputName,
        relativeDirectory: `data-exports/${schedule.id}`,
        bytes,
        sha256: createHash("sha256").update(csv).digest("hex"),
        retentionCount: schedule.retentionCount,
      });
      this.#dataOperations.audit("scheduled-data-export.staged", {
        id: schedule.id, runId, houseId: schedule.houseId, rows: response.quality.sampleCount,
      });
    } catch (error) {
      rmSync(payloadPath, { force: true });
      throw error;
    }
  }

  #validatedInput(houseId: string, value: unknown, update = false): ScheduledDataExportInput | ScheduledDataExportUpdate {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "Scheduled export must be an object");
    const body = value as Record<string, unknown>;
    const allowed = new Set(["name", "enabled", "frequency", "timeLocal", "dayOfWeek", "dayOfMonth", "period", "sensorIds", "measurementIds", "resolution", "aggregation", "retentionCount", ...(update ? ["baseRevision"] : [])]);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", `Unsupported fields: ${unknown.join(", ")}`);
    const house = this.#database.getHouse(houseId);
    if (!house) throw new ScheduledDataExportError(404, "HOME_NOT_FOUND", "Home was not found");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "Name must contain 1 to 120 characters");
    if (typeof body.enabled !== "boolean") throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "enabled must be a boolean");
    if (!FREQUENCIES.includes(body.frequency as ScheduledDataExportFrequency)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "frequency is not supported");
    if (typeof body.timeLocal !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(body.timeLocal)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "timeLocal must use HH:mm");
    const frequency = body.frequency as ScheduledDataExportFrequency;
    const dayOfWeek = frequency === "weekly" ? Number(body.dayOfWeek) : null;
    const dayOfMonth = frequency === "monthly" ? Number(body.dayOfMonth) : null;
    if (frequency === "weekly" && (dayOfWeek === null || !Number.isSafeInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "dayOfWeek must be from 0 to 6");
    if (frequency === "monthly" && (dayOfMonth === null || !Number.isSafeInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "dayOfMonth must be from 1 to 31");
    if (!PERIODS.includes(body.period as ScheduledDataExportPeriod)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "period is not supported");
    const sensorIds = Array.isArray(body.sensorIds) ? [...new Set(body.sensorIds)] : [];
    const measurementIds = Array.isArray(body.measurementIds) ? [...new Set(body.measurementIds)] : [];
    if (sensorIds.length < 1 || sensorIds.length > 50 || sensorIds.some((id) => typeof id !== "string")) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "Select between 1 and 50 sensors");
    if (measurementIds.length < 1 || measurementIds.length > 8 || measurementIds.some((id) => typeof id !== "string")) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "Select between 1 and 8 measurements");
    const availableSensors = new Set(this.#database.listSensors(houseId).filter((sensor) => sensor.enabled).map((sensor) => sensor.id));
    if ((sensorIds as string[]).some((id) => !availableSensors.has(id))) throw new ScheduledDataExportError(422, "INVALID_SCHEDULED_EXPORT_SCOPE", "A selected sensor is not available in this Home");
    const definitions = (measurementIds as string[]).map((id) => this.#database.getMeasurementDefinition(id));
    if (definitions.some((definition) => !definition?.enabled || definition.genericHistoryEnabled === false || definition.genericStatsEnabled === false)) throw new ScheduledDataExportError(422, "INVALID_SCHEDULED_EXPORT_SCOPE", "A selected measurement cannot be exported");
    const resolution = typeof body.resolution === "string" ? body.resolution : "";
    if (resolution !== "raw" && resolution !== "1h" && resolution !== "1d" && resolutionMilliseconds(resolution) === null) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "resolution is not supported");
    if (!AGGREGATIONS.includes(body.aggregation as AnalyticsAggregation)) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "aggregation is not supported");
    const aggregation = body.aggregation as AnalyticsAggregation;
    if (resolution === "raw" && aggregation !== "default" && aggregation !== "last") throw new ScheduledDataExportError(422, "INVALID_SCHEDULED_EXPORT", "Raw exports cannot use a bucket aggregation");
    if (resolution !== "raw" && definitions.some((definition) => !allowedAggregations(definition!).has(aggregation))) throw new ScheduledDataExportError(422, "INVALID_SCHEDULED_EXPORT", "The selected measurements do not share that aggregation");
    const bucketMs = resolutionMilliseconds(resolution);
    if (bucketMs && Math.ceil(periodMilliseconds(body.period as ScheduledDataExportPeriod) / bucketMs) + 1 > 5_000) throw new ScheduledDataExportError(422, "SCHEDULED_EXPORT_TOO_LARGE", "Choose a coarser resolution or shorter export period");
    const retentionCount = Number(body.retentionCount);
    if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "retentionCount must be from 1 to 365");
    const base = {
      name,
      enabled: body.enabled,
      frequency,
      timeLocal: body.timeLocal,
      dayOfWeek,
      dayOfMonth,
      period: body.period as ScheduledDataExportPeriod,
      sensorIds: sensorIds as string[],
      measurementIds: measurementIds as string[],
      resolution: resolution as Exclude<AnalyticsResolution, "auto">,
      aggregation,
      retentionCount,
    };
    if (!update) return base;
    const baseRevision = Number(body.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new ScheduledDataExportError(400, "INVALID_SCHEDULED_EXPORT", "baseRevision must be a positive integer");
    return { ...base, baseRevision };
  }

  #assertNasConfigured(): void {
    if (!this.targetConfigured()) throw new ScheduledDataExportError(409, "NAS_EXPORT_TARGET_REQUIRED", "Connect a NAS export destination in Set up first");
  }

  #tickSafely(): void {
    void this.tick().catch((error: unknown) => {
      console.error("[scheduled-data-exports] worker tick failed", error);
    });
  }

  #failStaleRuns(): void {
    const cutoff = new Date(this.#now().getTime() - PENDING_RUN_TIMEOUT_MS).toISOString();
    const stale = this.#database.db.prepare(`SELECT id, pending_run_id FROM scheduled_data_exports
      WHERE pending_run_id IS NOT NULL AND pending_started_at < ?`).all(cutoff) as unknown as Array<{ id: string; pending_run_id: string }>;
    for (const item of stale) {
      if (this.#operationsDirectory && /^[0-9a-f-]{36}$/iu.test(item.pending_run_id)) {
        rmSync(join(this.#operationsDirectory, `data-export-${item.pending_run_id}.request.json`), { force: true });
        rmSync(join(this.#operationsDirectory, `data-export-${item.pending_run_id}.csv`), { force: true });
      }
      const failedAt = this.#now().toISOString();
      const changed = this.#database.db.prepare(`UPDATE scheduled_data_exports SET last_run_status = 'failed',
        last_run_error = 'The NAS export worker did not finish in time', pending_run_id = NULL,
        pending_started_at = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ? AND pending_run_id = ?`).run(failedAt, item.id, item.pending_run_id);
      if (Number(changed.changes) === 1) this.#dataOperations.audit("scheduled-data-export.failed", {
        id: item.id, runId: item.pending_run_id, error: "worker-timeout",
      });
    }
  }

  #row(id: string): ScheduledExportRow | null {
    return (this.#database.db.prepare("SELECT * FROM scheduled_data_exports WHERE id = ?").get(id) as unknown as ScheduledExportRow | undefined) ?? null;
  }

  #migrate(): void {
    this.#database.db.exec(`CREATE TABLE IF NOT EXISTS scheduled_data_exports (
      id TEXT PRIMARY KEY,
      house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
      time_local TEXT NOT NULL,
      day_of_week INTEGER,
      day_of_month INTEGER,
      period TEXT NOT NULL CHECK (period IN ('24h', '7d', '30d', '90d')),
      sensor_ids_json TEXT NOT NULL,
      measurement_ids_json TEXT NOT NULL,
      resolution TEXT NOT NULL,
      aggregation TEXT NOT NULL,
      retention_count INTEGER NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT NOT NULL CHECK (last_run_status IN ('never', 'pending', 'complete', 'failed')),
      last_run_error TEXT,
      last_output_name TEXT,
      pending_run_id TEXT,
      pending_started_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_data_exports_due
      ON scheduled_data_exports(enabled, next_run_at) WHERE enabled = 1;`);
  }
}
