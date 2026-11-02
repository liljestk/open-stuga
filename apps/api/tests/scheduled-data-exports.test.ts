import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import {
  nextScheduledDataExportRun,
  ScheduledDataExportError,
  ScheduledDataExportService,
} from "../src/scheduled-data-exports.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

describe("scheduled data exports", () => {
  const directories: string[] = [];
  const databases: ClimateDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** `destination` is where the owner, owner-1, sends exports; schedules without an owner always go to the NAS. */
  function fixture(options: { ready?: boolean; destination?: "nas" | "dropbox" } = {}) {
    const ready = options.ready ?? true;
    const destination = options.destination ?? "nas";
    const members = new Map([["owner-1", { email: "owner@example.test", role: "owner" as const }]]);
    const selectedFor = (userId: string | null) => (userId && members.has(userId) ? destination : "nas");
    const operationsDirectory = mkdtempSync(join(tmpdir(), "stugu-scheduled-export-"));
    directories.push(operationsDirectory);
    const database = new ClimateDatabase(":memory:", true);
    databases.push(database);
    database.activateRealDataMode();
    database.insertMeasurementSamples([{
      sensorId: "sensor-01",
      metric: "temperature",
      value: 21.25,
      canonicalUnit: "°C",
      timestamp: "2026-08-02T10:15:00.000Z",
      source: "api",
      quality: "good",
    }]);
    const audit = vi.fn();
    const deliver = vi.fn(async (_userId: string | null) => "dropbox" as const);
    const service = new ScheduledDataExportService({
      database,
      telemetryReader: new HybridTelemetryReader({ local: database }),
      destinations: { selectedFor, readyFor: () => ready, deliver },
      people: { member: (userId: string) => members.get(userId) ?? null },
      dataOperations: { audit } as never,
      operationsDirectory,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    return { service, operationsDirectory, audit, deliver, members };
  }

  const input = {
    name: "Weekly readings",
    enabled: true,
    frequency: "weekly" as const,
    timeLocal: "02:00",
    dayOfWeek: 0,
    dayOfMonth: null,
    period: "24h" as const,
    sensorIds: ["sensor-01"],
    measurementIds: ["temperature"],
    resolution: "1h" as const,
    aggregation: "mean" as const,
    retentionCount: 12,
  };

  it("creates a Home schedule and stages a checksummed CSV handoff", async () => {
    const { service, operationsDirectory, audit } = fixture();
    const schedule = service.create("house-main", input, "owner-1");

    expect(schedule).toMatchObject({ houseId: "house-main", enabled: true, lastRunStatus: "never", ownerEmail: "owner@example.test", destination: "nas" });
    expect(schedule.nextRunAt).toBe("2026-08-08T23:00:00.000Z");

    const pending = await service.runNow(schedule.id);
    expect(pending.lastRunStatus).toBe("pending");
    const requestName = readdirSync(operationsDirectory).find((name) => name.endsWith(".request.json"));
    expect(requestName).toBeTruthy();
    const request = JSON.parse(readFileSync(join(operationsDirectory, requestName!), "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({
      schema: "stugu-data-export-request/v1",
      scheduleId: schedule.id,
      relativeDirectory: `data-exports/${schedule.id}`,
      retentionCount: 12,
    });
    const csv = readFileSync(join(operationsDirectory, request.payloadName as string), "utf8");
    expect(csv).toContain("Home time,UTC timestamp,Sensor name,Sensor ID,Temperature (°C)");
    expect(csv).toContain("21.3");
    expect(audit).toHaveBeenCalledWith("scheduled-data-export.staged", expect.objectContaining({ id: schedule.id }));

    writeFileSync(join(operationsDirectory, `data-export-${request.runId}.receipt.json`), JSON.stringify({
      schema: "stugu-data-export-receipt/v1",
      runId: request.runId,
      scheduleId: schedule.id,
      status: "complete",
      completedAt: "2026-08-02T12:01:00.000Z",
      outputName: request.outputName,
    }));
    service.reconcileReceipts();
    expect(service.get(schedule.id)).toMatchObject({
      lastRunStatus: "complete",
      lastOutputName: request.outputName,
    });
  });

  it("requires a connected export destination for active schedules", () => {
    const { service } = fixture({ ready: false });
    expect(() => service.create("house-main", input, "owner-1")).toThrowError(ScheduledDataExportError);
    expect(() => service.create("house-main", { ...input, enabled: false }, "owner-1")).not.toThrow();
  });

  it("uploads straight to a connected cloud drive and completes without the NAS worker", async () => {
    const { service, operationsDirectory, audit, deliver } = fixture({ destination: "dropbox" });
    const schedule = service.create("house-main", input, "owner-1");

    const completed = await service.runNow(schedule.id);

    expect(deliver).toHaveBeenCalledOnce();
    const [owner, file] = deliver.mock.calls[0] as unknown as [string, { folder: string[]; name: string; content: string; retentionCount: number }];
    expect(owner).toBe("owner-1");
    expect(schedule).toMatchObject({ ownerEmail: "owner@example.test", destination: "dropbox" });
    expect(file.folder).toEqual(["data-exports", schedule.id]);
    expect(file.name).toMatch(/^stugu-.+-1h-mean-[0-9a-f]{8}\.csv$/u);
    expect(file.content).toContain("Home time,UTC timestamp,Sensor name,Sensor ID,Temperature (°C)");
    expect(file.retentionCount).toBe(12);
    expect(completed).toMatchObject({ lastRunStatus: "complete", lastOutputName: file.name, lastRunError: null });
    expect(readdirSync(operationsDirectory)).toEqual([]);
    expect(audit).toHaveBeenCalledWith("scheduled-data-export.complete", expect.objectContaining({ id: schedule.id, destination: "dropbox" }));
  });

  it("records a cloud upload failure on the schedule", async () => {
    const { service, deliver } = fixture({ destination: "dropbox" });
    deliver.mockRejectedValueOnce(new Error("Dropbox access was removed. Connect Dropbox again in Set up."));
    const schedule = service.create("house-main", input, "owner-1");

    await expect(service.runNow(schedule.id)).rejects.toThrowError(ScheduledDataExportError);

    expect(service.get(schedule.id)).toMatchObject({
      lastRunStatus: "failed",
      lastRunError: "Dropbox access was removed. Connect Dropbox again in Set up.",
    });
  });

  it("sends a removed owner's schedule to the NAS instead of their cloud drive", async () => {
    const { service, operationsDirectory, deliver, members } = fixture({ destination: "dropbox" });
    const schedule = service.create("house-main", input, "owner-1");
    members.delete("owner-1");

    expect(service.get(schedule.id)).toMatchObject({ ownerEmail: null, destination: "nas" });
    await expect(service.runNow(schedule.id)).resolves.toMatchObject({ lastRunStatus: "pending" });

    expect(deliver).not.toHaveBeenCalled();
    expect(readdirSync(operationsDirectory).some((name) => name.endsWith(".request.json"))).toBe(true);
  });

  it("gives schedules from before 0.62.0 no owner and keeps them on the NAS", () => {
    const operationsDirectory = mkdtempSync(join(tmpdir(), "stugu-scheduled-export-legacy-"));
    directories.push(operationsDirectory);
    const database = new ClimateDatabase(":memory:", true);
    databases.push(database);
    database.db.exec(`CREATE TABLE scheduled_data_exports (
      id TEXT PRIMARY KEY, house_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL, frequency TEXT NOT NULL,
      time_local TEXT NOT NULL, day_of_week INTEGER, day_of_month INTEGER, period TEXT NOT NULL, sensor_ids_json TEXT NOT NULL,
      measurement_ids_json TEXT NOT NULL, resolution TEXT NOT NULL, aggregation TEXT NOT NULL, retention_count INTEGER NOT NULL,
      next_run_at TEXT, last_run_at TEXT, last_run_status TEXT NOT NULL, last_run_error TEXT, last_output_name TEXT,
      pending_run_id TEXT, pending_started_at TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO scheduled_data_exports VALUES ('legacy-1', 'house-main', 'Old export', 0, 'daily', '02:00', NULL, NULL, '24h',
      '["sensor-01"]', '["temperature"]', '1h', 'mean', 3, NULL, NULL, 'never', NULL, NULL, NULL, NULL, 1,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');`);
    const service = new ScheduledDataExportService({
      database,
      telemetryReader: new HybridTelemetryReader({ local: database }),
      destinations: { selectedFor: (userId) => (userId ? "dropbox" : "nas"), readyFor: () => true, deliver: vi.fn() },
      people: { member: () => null },
      dataOperations: { audit: vi.fn() } as never,
      operationsDirectory,
    });

    expect(service.get("legacy-1")).toMatchObject({ name: "Old export", ownerEmail: null, destination: "nas" });
  });

  it("resolves monthly end-of-month schedules in the Home timezone", () => {
    expect(nextScheduledDataExportRun({
      frequency: "monthly",
      timeLocal: "02:00",
      dayOfWeek: null,
      dayOfMonth: 31,
    }, "Europe/Helsinki", new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-29T23:00:00.000Z");
  });

  it("runs only once during a repeated daylight-saving wall-clock time", () => {
    const schedule = { frequency: "daily" as const, timeLocal: "03:30", dayOfWeek: null, dayOfMonth: null };
    const first = nextScheduledDataExportRun(schedule, "Europe/Helsinki", new Date("2026-10-24T22:00:00.000Z"));
    expect(first).toBe("2026-10-25T00:30:00.000Z");
    expect(nextScheduledDataExportRun(schedule, "Europe/Helsinki", new Date(first))).toBe("2026-10-26T01:30:00.000Z");
  });
});
